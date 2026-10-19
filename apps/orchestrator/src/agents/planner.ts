import { PlanV1 } from '@aik/contracts';
import { acceptanceCriteria, agentRuns, plans, projects, userStories, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import { ensureModelProfile, type ModelRef, type OpenCodeRuntime } from './runtime.ts';

export interface PlannerAgentDeps {
  db: AikDb;
  workflow: WorkflowService;
  bus: EventBus;
  runtime: OpenCodeRuntime;
  now?: Clock;
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
  private readonly now: Clock;

  constructor(deps: PlannerAgentDeps) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.runtime = deps.runtime;
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

    // Create an active run record
    const runIdempotency = `plan_${story.id}_${Date.now()}`;
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

    const prompt = `You are an expert AI software architect and planner.
Produce an implementation plan for the following user story in repository: "${project.name}".

STORY TITLE: ${story.title}
DESCRIPTION: ${story.description || 'No description provided.'}
ACCEPTANCE CRITERIA:
${acList.length > 0 ? acList.map((ac, i) => `${i + 1}. ${ac}`).join('\n') : '- Implement standard functionality.'}

Respond with a JSON object conforming to the PlanV1 schema:
{
  "schemaVersion": 1,
  "summary": "Brief explanation of the technical approach",
  "assumptions": ["assumption 1"],
  "clarificationQuestions": [],
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
Output only the JSON code block.`;

    const result = await this.runtime.runOneShot({
      title: `Plan ${story.key}`,
      directory: project.repoPath,
      prompt,
      model: input.model,
      onSessionCreated: (sessionId, model) => {
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

    this.db
      .update(agentRuns)
      .set({ status: 'succeeded', endedAt: new Date(this.now()) })
      .where(eq(agentRuns.id, run.id))
      .run();

    this.db
      .update(userStories)
      .set({
        activeRunId: null,
        planningStatus: 'plan_proposed',
        activePlanId: savedPlan.id,
        updatedAt: new Date(this.now()),
      })
      .where(eq(userStories.id, story.id))
      .run();
    this.bus.notify(1);

    if (input.autoAccept) {
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
