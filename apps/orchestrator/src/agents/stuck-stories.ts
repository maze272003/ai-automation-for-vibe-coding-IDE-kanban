// apps/orchestrator/src/agents/stuck-stories.ts
// Workflow-integrity sweep (spec 2026-11-07 workflow-integrity RE1–RE4): every non-terminal
// story keeps moving or lands visibly in BLOCKED. Also owns the shared stage-enqueue helpers
// the runner's discoverers use, so discoverer and sweep can never diverge on keys or bounds.
import type { BlockedReason } from '@aik/contracts';
import {
  agentRuns, durableJobs, projects, storyEvents, userStories, verificationRuns, type AikDb,
} from '@aik/db';
import type { WorkflowEvent } from '@aik/workflow';
import { and, desc, eq, inArray, isNotNull, isNull, like, notInArray } from 'drizzle-orm';
import { heavyLane } from '../jobs/lane.ts';
import type { JobKind, JobQueue } from '../jobs/queue.ts';
import { createRedactor } from '../secrets/redactor.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import { finishRun } from './finish-run.ts';
import { failedPlannerRunsSinceReset, MAX_PLANNING_ATTEMPTS } from './planning-budget.ts';
import { settledReviewFor } from './review-status.ts';

/**
 * How many times a stage may be re-enqueued per status version (RE2): r0 plus two retries,
 * then the stage fails the story honestly instead of looping forever.
 */
export const MAX_STAGE_JOB_RETRIES = 2;

export type StageKind = 'implement' | 'rework' | 'verify' | 'review';

/** The story fields a stage enqueue needs: identity, the round namespace and the lane. */
export interface StageStory {
  id: number;
  statusVersion: number;
  repoPath: string;
}

export interface StageDeps {
  db: AikDb;
  queue: JobQueue;
  workflow: WorkflowService;
  redact: (text: string) => string;
  now: Clock;
}

/**
 * The retry round a stage is on (RE1): how many failed/dead durable jobs this story already
 * spent on `base` under the current `statusVersion`. Every transition bumps `statusVersion`,
 * so a human `recover()` resets the budget instead of colliding with it.
 */
export function stageRound(db: AikDb, storyId: number, base: string, statusVersion: number): number {
  return db
    .select({ id: durableJobs.id })
    .from(durableJobs)
    .where(and(
      eq(durableJobs.storyId, storyId),
      inArray(durableJobs.status, ['failed', 'dead']),
      like(durableJobs.idempotencyKey, `${base}_${statusVersion}_r%`),
    ))
    .all().length;
}

/**
 * Enqueues a stage job under the round-scoped key `<base>_<statusVersion>_r<n>` (RE1). When
 * the round budget is spent (n > MAX_STAGE_JOB_RETRIES) the story fails instead (RE2) with a
 * detail naming the stage, the round and the redacted last error. Retries (n >= 1) that
 * actually create a job leave one informational storyEvents row behind (RE4); the silent r0
 * is normal operation.
 */
export function enqueueStage(
  deps: StageDeps,
  story: StageStory,
  stage: StageKind,
  base: string,
  opts: { sideEffecting: boolean },
): 'enqueued' | 'blocked' {
  const round = stageRound(deps.db, story.id, base, story.statusVersion);
  if (round > MAX_STAGE_JOB_RETRIES) {
    const reason: BlockedReason = stage === 'review' ? 'reviewer_blocked' : 'environment';
    const last = deps.db
      .select({ lastError: durableJobs.lastError })
      .from(durableJobs)
      .where(and(
        eq(durableJobs.storyId, story.id),
        inArray(durableJobs.status, ['failed', 'dead']),
        like(durableJobs.idempotencyKey, `${base}_${story.statusVersion}_r%`),
      ))
      .orderBy(desc(durableJobs.id))
      .limit(1)
      .get();
    const lastError = last?.lastError ? deps.redact(last.lastError) : 'no error recorded';
    deps.workflow.transition({
      storyId: story.id,
      event: {
        type: 'fail',
        reason,
        detail: `stage ${stage} exhausted its ${MAX_STAGE_JOB_RETRIES} retries at round r${round}; last error: ${lastError}`,
      },
      actor: 'system',
    });
    return 'blocked';
  }
  const kind: JobKind = stage === 'rework' ? 'implement' : stage;
  const { created } = deps.queue.enqueue({
    kind,
    slot: heavyLane(story.repoPath),
    storyId: story.id,
    sideEffecting: opts.sideEffecting,
    idempotencyKey: `${base}_${story.statusVersion}_r${round}`,
  });
  if (round >= 1 && created) {
    deps.db
      .insert(storyEvents)
      .values({
        storyId: story.id,
        type: 'internal_error',
        actor: 'system',
        payload: { message: deps.redact(`stage retried: ${stage} r${round}`), stage, ordinal: round },
        createdAt: new Date(deps.now()),
      })
      .run();
  }
  return 'enqueued';
}

/** Stories whose re-fire a previous sweep already saw rejected by guards (this process). */
const refireRejected = new Set<number>();

/** Test hook: clears the per-process re-fire skip-set so a scenario can re-run cleanly. */
export function resetSweepMemory(): void {
  refireRejected.clear();
}

export interface SweepDeps {
  db: AikDb;
  queue: JobQueue;
  workflow: WorkflowService;
  redact?: (text: string) => string;
  now?: Clock;
}

export interface SweepSummary {
  blocked: number;
  enqueued: number;
  refired: number;
  skipped: number;
}

/**
 * Finds stories the discoverers can no longer move (RE3): non-terminal, not on hold, not
 * cancelled, and with no queued/leased durable job for the story at all — so the sweep can
 * never fight a live handler, including an expired-but-leased job. Post-evidence transitions
 * are re-fired, planning budget exhaustion and orphaned runs block honestly, and stage jobs
 * are re-enqueued through the same bounded `enqueueStage` the discoverers use.
 */
export function sweepStuckStories(deps: SweepDeps): SweepSummary {
  const db = deps.db;
  const redact = deps.redact ?? createRedactor().redact;
  const now = deps.now ?? systemClock;
  const stageDeps: StageDeps = { db, queue: deps.queue, workflow: deps.workflow, redact, now };
  const summary: SweepSummary = { blocked: 0, enqueued: 0, refired: 0, skipped: 0 };

  const busy = new Set(
    db
      .select({ storyId: durableJobs.storyId })
      .from(durableJobs)
      .where(and(inArray(durableJobs.status, ['queued', 'leased']), isNotNull(durableJobs.storyId)))
      .all()
      .map((r) => r.storyId),
  );

  const stories = db
    .select({
      id: userStories.id,
      status: userStories.status,
      statusVersion: userStories.statusVersion,
      planningStatus: userStories.planningStatus,
      candidateSha: userStories.candidateSha,
      activeRunId: userStories.activeRunId,
      repoPath: projects.repoPath,
    })
    .from(userStories)
    .innerJoin(projects, eq(projects.id, userStories.projectId))
    .where(and(
      notInArray(userStories.status, ['DONE', 'CANCELLED', 'BLOCKED']),
      eq(userStories.hold, false),
      isNull(userStories.cancelledAt),
    ))
    .all();

  for (const story of stories) {
    if (busy.has(story.id) || refireRejected.has(story.id)) {
      summary.skipped += 1;
      continue;
    }

    const block = (reason: BlockedReason, detail: string): void => {
      deps.workflow.transition({ storyId: story.id, event: { type: 'fail', reason, detail }, actor: 'system' });
      summary.blocked += 1;
    };

    // The sweep only re-dispatches a stage: a stage with no failed round under the current
    // status version is the discoverer's first dispatch, never the sweep's.
    const stage = (kind: StageKind, base: string, sideEffecting: boolean): void => {
      if (stageRound(db, story.id, base, story.statusVersion) < 1) {
        summary.skipped += 1;
        return;
      }
      if (enqueueStage(stageDeps, story, kind, base, { sideEffecting }) === 'enqueued') {
        summary.enqueued += 1;
      } else {
        summary.blocked += 1;
      }
    };

    // Re-fires a transition the crash interrupted. An exhausted `attempts` guard blocks the
    // story (retry_limit); any other guard failure is an evidence mismatch, recorded once and
    // skipped for the rest of this process (RE3) — a restart allows exactly one more attempt.
    const refire = (event: WorkflowEvent): void => {
      const outcome = deps.workflow.transition({ storyId: story.id, event, actor: 'system' });
      if (outcome.ok) {
        summary.refired += 1;
        return;
      }
      const reasons = (outcome.failedGuards ?? []).map((g) => `${g.guard}: ${g.reason}`);
      if (outcome.failedGuards?.some((g) => g.guard === 'attempts')) {
        block('retry_limit', redact(`integrity re-fire rejected because the attempt budget is exhausted (${reasons.join('; ')})`));
        return;
      }
      db
        .insert(storyEvents)
        .values({
          storyId: story.id,
          type: 'internal_error',
          actor: 'system',
          payload: { message: redact('integrity re-fire rejected by guards'), reasons },
          createdAt: new Date(now()),
        })
        .run();
      refireRejected.add(story.id);
      summary.skipped += 1;
    };

    switch (story.status) {
      case 'AWAITING_MERGE':
        // Waits for human merge approval by design.
        summary.skipped += 1;
        break;

      case 'NEW': {
        if (story.planningStatus !== 'planning_failed') {
          summary.skipped += 1;
          break;
        }
        // B7: the budget is per planning round — failures before the last human reset
        // (edit_definition or recover→NEW) do not count.
        const failedPlans = failedPlannerRunsSinceReset(db, story.id);
        if (failedPlans >= MAX_PLANNING_ATTEMPTS) {
          block('invalid_agent_output', redact(`Planning failed ${failedPlans} times; the planning budget is exhausted`));
        } else {
          summary.skipped += 1;
        }
        break;
      }

      case 'READY':
      case 'REWORK':
        stage('implement', `implement_${story.id}`, true);
        break;

      case 'TESTING': {
        if (!story.candidateSha) {
          summary.skipped += 1;
          break;
        }
        const verification = db
          .select({ status: verificationRuns.status })
          .from(verificationRuns)
          .where(and(
            eq(verificationRuns.storyId, story.id),
            eq(verificationRuns.commitSha, story.candidateSha),
            eq(verificationRuns.trigger, 'candidate'),
          ))
          .orderBy(desc(verificationRuns.id))
          .limit(1)
          .get();
        if (!verification || verification.status === 'running') {
          stage('verify', `verify_${story.id}_${story.candidateSha}`, false);
          break;
        }
        if (verification.status === 'passed') {
          refire({ type: 'verification_passed', sha: story.candidateSha });
          break;
        }
        stage('rework', `rework_${story.id}_${story.candidateSha}`, true);
        break;
      }

      case 'READY_FOR_REVIEW': {
        if (!story.candidateSha) {
          summary.skipped += 1;
          break;
        }
        // W0-7: only a SETTLED review (APPROVED/CHANGES_REQUESTED) settles the round. A story
        // whose only review for the SHA is BLOCKED was resumed after the block and must be
        // reviewed again — exactly like a story with no review at all.
        const settled = settledReviewFor(db, story.id, story.candidateSha);
        if (!settled) {
          stage('review', `review_${story.id}_${story.candidateSha}`, false);
          break;
        }
        if (settled.verdict === 'APPROVED') {
          refire({ type: 'review_approved', sha: story.candidateSha });
          break;
        }
        refire({ type: 'review_changes_requested', sha: story.candidateSha });
        break;
      }

      case 'IN_PROGRESS': {
        if (story.activeRunId === null) {
          block('environment', redact('run lost before it started: the story is IN_PROGRESS but has no active run'));
          break;
        }
        const run = db
          .select({ id: agentRuns.id, status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, story.activeRunId))
          .get();
        if (!run) {
          block('environment', redact(`run lost before it started: active run ${story.activeRunId} has no agent_runs row`));
          break;
        }
        if (run.status === 'running') {
          finishRun(db, new Date(now()), {
            runId: run.id,
            status: 'interrupted',
            exitReason: 'Orphaned by integrity sweep',
            usage: null,
            model: null,
            durationMs: null,
          });
          block('interrupted', redact(`run ${run.id} was still running with no live job; marked interrupted by the integrity sweep`));
          break;
        }
        block('interrupted', redact(`run ${run.id} already ended as ${run.status} while the story stayed IN_PROGRESS`));
        break;
      }
    }
  }

  return summary;
}
