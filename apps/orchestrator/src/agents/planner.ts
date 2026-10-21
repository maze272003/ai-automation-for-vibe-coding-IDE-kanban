import { PlanV1 } from '@aik/contracts';
import { acceptanceCriteria, agentRuns, clarifications, plans, projects, userStories, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { EventBus } from '../events/bus.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { RunInterruptRegistry } from './interrupts.ts';
import { ensureModelProfile, ROLE_TIMEOUTS, type ModelRef, type OpenCodeRuntime, type RunOneShotOutput } from './runtime.ts';
import type { SkillBridgeService } from '../skills/bridge.ts';

export interface PlannerAgentDeps {
  db: AikDb;
  workflow: WorkflowService;
  bus: EventBus;
  runtime: OpenCodeRuntime;
  now?: Clock;
  /** When provided, the planning session registers as the story's interruptible run (EXE-13). */
  interrupts?: RunInterruptRegistry;
  skills?: SkillBridgeService;
}

export interface PlanStoryInput {
  storyId: number;
  autoAccept?: boolean;
  model?: ModelRef;
}

export interface PlanStoryResult {
  ok: boolean;
  planId?: number;
  error?: string;
}

export class PlannerAgent {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly runtime: OpenCodeRuntime;
  private readonly interrupts?: RunInterruptRegistry;
  private readonly skills?: SkillBridgeService;
  private readonly now: Clock;

  constructor(deps: PlannerAgentDeps) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.runtime = deps.runtime;
    this.interrupts = deps.interrupts;
    this.skills = deps.skills;
    this.now = deps.now ?? systemClock;
  }

  async planStory(input: PlanStoryInput): Promise<PlanStoryResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, input.storyId)).get();
    if (!story) {
      return { ok: false, error: `Story ${input.storyId} not found` };
    }
    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) {
      return { ok: false, error: `Project for story ${input.storyId} not found` };
    }

    const acList = this.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.storyId, story.id))
      .all()
      .map((ac) => ac.text);

    // Create an active run record. The random suffix keeps run_idem_uq safe when two planner
    // runs for one story start within the same millisecond (re-plan after reject/answers).
    const runIdempotency = `plan_${story.id}_${Date.now()}_${crypto.randomUUID()}`;
    const run = this.db
      .insert(agentRuns)
      .values({
        storyId: story.id,
        role: 'planner',
        attempt: story.attemptCount + 1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status: 'running',
        idempotencyKey: runIdempotency,
        startedAt: new Date(this.now()),
      })
      .returning()
      .get();

    // Attach active run to story so the UI Kanban card immediately shows the working terminal badge
    this.db
      .update(userStories)
      .set({ activeRunId: run.id, planningStatus: 'planning', updatedAt: new Date(this.now()) })
      .where(eq(userStories.id, story.id))
      .run();
    this.bus.notify(1);

    // Re-plan context (spec §19.2): carry prior rejection feedback and answered clarifications
    // into the prompt so re-plans build on the human's feedback instead of repeating mistakes.
    const priorPlans = this.db
      .select()
      .from(plans)
      .where(eq(plans.storyId, story.id))
      .all()
      .sort((a, b) => b.version - a.version);
    const rejectionFeedback = priorPlans.find((p) => p.status === 'rejected')?.rejectionFeedback;
    const latestPlan = priorPlans[0];
    const answeredClarifications = latestPlan
      ? this.db
          .select()
          .from(clarifications)
          .where(eq(clarifications.planId, latestPlan.id))
          .all()
          .filter((c) => c.answer !== null)
          .sort((a, b) => a.ordinal - b.ordinal)
      : [];

    const feedbackSection = rejectionFeedback
      ? `PREVIOUS PLAN FEEDBACK (the user rejected an earlier plan for this story):\n${rejectionFeedback}\n`
      : '';
    const answersSection =
      answeredClarifications.length > 0
        ? `CLARIFICATION ANSWERS (the user answered the previous plan's clarification questions):\n${answeredClarifications
            .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
            .join('\n')}\n`
        : '';
    const replanContext =
      feedbackSection || answersSection
        ? `\n${[feedbackSection, answersSection].filter(Boolean).join('\n')}\nIncorporate the previous plan feedback and clarification answers above into the new plan; do not re-ask questions that have already been answered.\n`
        : '';

    let skillPromptHint = '';
    if (this.skills) {
      const injection = await this.skills.injectSkills({
        targetDirectory: project.repoPath,
        role: 'planner',
        storyTitle: story.title,
        storyDescription: story.description ?? undefined,
        repoPath: project.repoPath,
        isWorktree: false,
      });
      skillPromptHint = injection.promptHint ? `\n${injection.promptHint}\n` : '';
    }

    const prompt = `You are an expert AI software architect and planner.
Produce an implementation plan for the following user story in repository: "${project.name}".

STORY TITLE: ${story.title}
DESCRIPTION: ${story.description || 'No description provided.'}
ACCEPTANCE CRITERIA:
${acList.length > 0 ? acList.map((ac, i) => `${i + 1}. ${ac}`).join('\n') : '- Implement standard functionality.'}
${replanContext}${skillPromptHint}
Respond with a JSON object conforming to the PlanV1 schema:
{
  "schemaVersion": 1,
  "summary": "Brief explanation of the technical approach",
  "assumptions": ["assumption 1"],
  "clarificationQuestions": ["question that genuinely blocks a correct plan"],
  "acceptanceCriteria": [
    { "ref": "AC-1", "text": "description", "testable": true, "verification": "how to verify" }
  ],
  "subtasks": [
    { "id": "1", "description": "Step 1", "files": ["path/to/file"] }
  ],
  "affectedFiles": ["path/to/file"],
  "requiredTests": ["path/to/test"],
  "migrations": { "required": false, "notes": "" },
  "securitySensitive": [],
  "dependencyChanges": [],
  "conflictsWith": [],
  "complexity": "S",
  "risks": []
}
You MAY include entries in "clarificationQuestions", but only questions that genuinely block a
correct plan — never invent business rules or assumptions to fill gaps. If the story and the
context above already provide everything needed, return an empty list.
Output only the JSON code block.`;

    let result: RunOneShotOutput;
    try {
      result = await this.runtime.runOneShot({
        title: `Plan ${story.key}`,
        directory: project.repoPath,
        prompt,
        model: input.model,
        timeoutMs: ROLE_TIMEOUTS.planner,
        shouldStop: () => this.interrupts?.isStopRequested(story.id) ?? false,
        onSessionCreated: (sessionId, model) => {
          this.interrupts?.register(story.id, {
            runId: run.id,
            stop: async () => {
              await this.runtime.interrupt(sessionId, project.repoPath);
            },
          });
          const modelProfileId = ensureModelProfile(this.db, model);
          this.db
            .update(agentRuns)
            .set({
              opencodeSessionId: sessionId,
              ...(modelProfileId ? { modelProfileId } : {}),
            })
            .where(eq(agentRuns.id, run.id))
            .run();
          this.bus.notify(1);
        },
      });
    } finally {
      // The handle must never outlive the run (EXE-13); unregistering also clears the stop flag.
      this.interrupts?.unregister(story.id);
      if (this.skills) {
        await this.skills.cleanupSkills(project.repoPath);
      }
    }

    if (result.interrupted) {
      // The stop request already transitioned the story to BLOCKED(interrupted)/CANCELLED; a fail
      // transition here would just GUARD_FAILED, and no attempt was consumed (EXE-13).
      this.db
        .update(agentRuns)
        .set({ status: 'interrupted', exitReason: 'Interrupted by a stop request', endedAt: new Date(this.now()) })
        .where(eq(agentRuns.id, run.id))
        .run();
      this.bus.notify(1);
      return { ok: false, error: `The planning run for ${story.key} was interrupted by a stop request` };
    }

    if (!result.ok || !result.text) {
      this.db
        .update(agentRuns)
        .set({ status: 'failed', exitReason: result.error ?? 'No response', endedAt: new Date(this.now()) })
        .where(eq(agentRuns.id, run.id))
        .run();
      this.db
        .update(userStories)
        .set({ activeRunId: null, planningStatus: 'planning_failed', updatedAt: new Date(this.now()) })
        .where(eq(userStories.id, story.id))
        .run();
      this.bus.notify(1);
      return { ok: false, error: result.error ?? 'Planning failed' };
    }

    const planContent = this.parsePlan(result.text, story.title);
    const questions = planContent.clarificationQuestions;

    // Save plan as proposed
    const version = (this.db.select().from(plans).where(eq(plans.storyId, story.id)).all().length || 0) + 1;
    const savedPlan = this.db
      .insert(plans)
      .values({
        storyId: story.id,
        version,
        storyRevision: story.revision,
        agentRunId: run.id,
        content: planContent,
        status: 'proposed',
        createdAt: new Date(this.now()),
      })
      .returning()
      .get();

    // Open questions park the story in needs_clarification; the plan itself stays 'proposed'
    // (EXE-7 AC2). One row per question, ordinal 1..n, awaiting the human's answers.
    questions.forEach((question, index) => {
      this.db
        .insert(clarifications)
        .values({
          planId: savedPlan.id,
          ordinal: index + 1,
          question,
          answer: null,
        })
        .run();
    });

    this.db
      .update(agentRuns)
      .set({ status: 'succeeded', endedAt: new Date(this.now()) })
      .where(eq(agentRuns.id, run.id))
      .run();

    this.db
      .update(userStories)
      .set({
        activeRunId: null,
        planningStatus: questions.length > 0 ? 'needs_clarification' : 'plan_proposed',
        activePlanId: savedPlan.id,
        updatedAt: new Date(this.now()),
      })
      .where(eq(userStories.id, story.id))
      .run();
    this.bus.notify(1);

    // Auto-accept only applies to plans with zero open clarification questions (EXE-7 AC2/AC4).
    if (questions.length === 0 && input.autoAccept) {
      this.workflow.transition({
        storyId: story.id,
        event: { type: 'auto_accept_plan', planVersion: version },
        actor: 'system',
      });
    }

    return { ok: true, planId: savedPlan.id };
  }

  private parsePlan(text: string, fallbackTitle: string): PlanV1 {
    try {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, text];
      const jsonStr = match[1] ?? text;
      const parsed = JSON.parse(jsonStr.trim()) as unknown;
      return PlanV1.parse(parsed);
    } catch {
      // Graceful fallback for non-strict LLM formatting
      return {
        schemaVersion: 1,
        summary: text.slice(0, 300) || `Implementation plan for ${fallbackTitle}`,
        assumptions: [],
        clarificationQuestions: [],
        acceptanceCriteria: [],
        subtasks: [{ id: '1', description: `Implement ${fallbackTitle}`, files: [] }],
        affectedFiles: [],
        requiredTests: [],
        migrations: { required: false, notes: '' },
        securitySensitive: [],
        dependencyChanges: [],
        conflictsWith: [],
        complexity: 'M',
        risks: [],
      };
    }
  }
}
