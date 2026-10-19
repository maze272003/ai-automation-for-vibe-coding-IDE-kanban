import { agentRuns, plans, projects, userStories, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import type { EventBus } from '../events/bus.ts';
import type { WorktreeManager } from '../git/worktree.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import { ensureModelProfile, type ModelRef, type OpenCodeRuntime } from './runtime.ts';

export interface ImplementerAgentDeps {
  db: AikDb;
  workflow: WorkflowService;
  bus: EventBus;
  runtime: OpenCodeRuntime;
  worktreeManager: WorktreeManager;
  now?: Clock;
}

export interface ImplementStoryInput {
  storyId: number;
  model?: ModelRef;
}

export interface ImplementStoryResult {
  ok: boolean;
  candidateSha?: string;
  error?: string;
}

export class ImplementerAgent {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly runtime: OpenCodeRuntime;
  private readonly worktreeManager: WorktreeManager;
  private readonly now: Clock;

  constructor(deps: ImplementerAgentDeps) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.runtime = deps.runtime;
    this.worktreeManager = deps.worktreeManager;
    this.now = deps.now ?? systemClock;
  }

  async implementStory(input: ImplementStoryInput): Promise<ImplementStoryResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, input.storyId)).get();
    if (!story) {
      return { ok: false, error: `Story ${input.storyId} not found` };
    }
    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) {
      return { ok: false, error: `Project for story ${input.storyId} not found` };
    }

    // 1. Prepare worktree
    const { worktreePath } = await this.worktreeManager.ensureStoryWorktree({
      repoPath: project.repoPath,
      storyKey: story.key,
      baseBranch: project.baseBranch,
    });

    // 2. Create agent run record
    const runIdempotency = `impl_${story.id}_${Date.now()}`;
    const run = this.db
      .insert(agentRuns)
      .values({
        storyId: story.id,
        role: 'implementer',
        attempt: story.attemptCount + 1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status: 'running',
        idempotencyKey: runIdempotency,
        startedAt: new Date(this.now()),
      })
      .returning()
      .get();

    // 3. Claim implementation in state machine (transitions READY -> IN_PROGRESS)
    const claim = this.workflow.transition({
      storyId: story.id,
      event: {
        type: 'claim_implement',
        runId: run.id,
        leaseHeld: true,
        worktreeReady: true,
      },
      actor: 'system',
    });

    if (!claim.ok) {
      this.db
        .update(agentRuns)
        .set({ status: 'failed', exitReason: claim.code, endedAt: new Date(this.now()) })
        .where(eq(agentRuns.id, run.id))
        .run();
      return { ok: false, error: `Claim failed: ${claim.code}` };
    }

    // Read active plan if available
    const activePlan = story.activePlanId
      ? this.db.select().from(plans).where(eq(plans.id, story.activePlanId)).get()
      : null;

    const planSummary = activePlan?.content.summary ?? 'Implement the requested user story.';
    const subtasks = activePlan?.content.subtasks.map((t) => `- ${t.description}`).join('\n') ?? '';

    const prompt = `You are an expert AI software engineer implementing user story "${story.key}: ${story.title}".

DESCRIPTION:
${story.description || 'No description provided.'}

APPROVED PLAN:
${planSummary}

SUBTASKS:
${subtasks}

Instructions:
Edit and create the necessary files directly in the repository to complete all acceptance criteria.
Write high-quality, clean code and tests.`;

    const result = await this.runtime.runOneShot({
      title: `Implement ${story.key}`,
      directory: worktreePath,
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

    if (!result.ok) {
      this.db
        .update(agentRuns)
        .set({ status: 'failed', exitReason: result.error ?? 'Model error', endedAt: new Date(this.now()) })
        .where(eq(agentRuns.id, run.id))
        .run();
      this.db.update(userStories).set({ activeRunId: null }).where(eq(userStories.id, story.id)).run();
      this.bus.notify(1);
      return { ok: false, error: result.error };
    }

    // Stage all changes
    execFileSync('git', ['add', '.'], { cwd: worktreePath, encoding: 'utf8' });
    const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    if (!gitStatus) {
      this.db
        .update(agentRuns)
        .set({ status: 'failed', exitReason: 'No changes produced', endedAt: new Date(this.now()) })
        .where(eq(agentRuns.id, run.id))
        .run();
      this.db.update(userStories).set({ activeRunId: null }).where(eq(userStories.id, story.id)).run();
      this.bus.notify(1);
      return { ok: false, error: 'The model made no file changes' };
    }

    // Commit changes
    const commitMsg = `feat(${story.key}): ${story.title}\n\nStory: ${story.key}\nRun: ${run.id}`;
    execFileSync('git', ['-c', 'user.name=aik-agent', '-c', 'user.email=aik-agent@localhost', 'commit', '-m', commitMsg], {
      cwd: worktreePath,
      encoding: 'utf8',
    });

    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    this.db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        resultSha: candidateSha,
        endedAt: new Date(this.now()),
      })
      .where(eq(agentRuns.id, run.id))
      .run();

    // Transition IN_PROGRESS -> TESTING
    const commitTransition = this.workflow.transition({
      storyId: story.id,
      event: {
        type: 'candidate_committed',
        runId: run.id,
        candidateSha,
        candidateTree,
        diffEmpty: false,
        treeAlreadyRejected: false,
      },
      actor: 'system',
    });

    if (!commitTransition.ok) {
      return { ok: false, error: `Commit transition failed: ${commitTransition.code}` };
    }

    return { ok: true, candidateSha };
  }
}
