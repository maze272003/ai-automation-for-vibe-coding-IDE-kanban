import {
  agentRuns, durableJobs, outboxEvents, reviewAcResults, reviewFindings, reviews, storyEvents, userStories,
  verificationChecks, verificationRuns,
} from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resetSweepMemory, sweepStuckStories, type SweepDeps } from '../src/agents/stuck-stories.ts';
import { EventBus } from '../src/events/bus.ts';
import { heavyLane } from '../src/jobs/lane.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedProject, seedStory } from './helpers/db.ts';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = 1_700_000_000_000;

describe('sweepStuckStories', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let workflow: WorkflowService;
  let queue: JobQueue;
  let deps: SweepDeps;

  beforeAll(() => {
    dbHolder = createTestDb();
    const bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus, now: () => NOW });
    queue = new JobQueue(dbHolder.db);
    deps = { db: dbHolder.db, queue, workflow, now: () => NOW };
  });

  afterAll(() => {
    dbHolder.close();
  });

  beforeEach(() => {
    resetSweepMemory();
  });

  const storyRow = (storyId: number) => dbHolder.db.select().from(userStories).where(eq(userStories.id, storyId)).get()!;

  const internalErrorRows = (storyId: number) =>
    dbHolder.db
      .select()
      .from(storyEvents)
      .where(and(eq(storyEvents.storyId, storyId), eq(storyEvents.type, 'internal_error')))
      .all();

  /** Passed candidate verification evidence: a passed run plus one passed mandatory check. */
  const seedPassedVerification = (storyId: number) => {
    const run = dbHolder.db
      .insert(verificationRuns)
      .values({ storyId, commitSha: SHA, trigger: 'candidate', status: 'passed', startedAt: new Date(NOW), endedAt: new Date(NOW) })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: run.id,
        checkKey: 'secrets',
        mandatory: true,
        command: 'internal:secrets',
        cwd: 'C:/repos/sweep',
        status: 'passed',
        startedAt: new Date(NOW),
        endedAt: new Date(NOW),
      })
      .run();
    return run;
  };

  const seedFailedVerification = (storyId: number) => {
    dbHolder.db
      .insert(verificationRuns)
      .values({ storyId, commitSha: SHA, trigger: 'candidate', status: 'failed', startedAt: new Date(NOW), endedAt: new Date(NOW) })
      .run();
  };

  const seedReview = (storyId: number, verdict: 'APPROVED' | 'CHANGES_REQUESTED') =>
    dbHolder.db
      .insert(reviews)
      .values({
        storyId,
        commitSha: SHA,
        actor: 'agent',
        rawVerdict: verdict,
        verdict,
        summary: 'Sweep review',
        raw: { schemaVersion: 1, verdict, summary: 'Sweep review', acChecklist: [], findings: [], priorFindings: [] },
        createdAt: new Date(NOW),
      })
      .returning()
      .get();

  /** A terminal durable-job row of a stage round (the retry counter's input, RE1). */
  const seedFailedStageJob = (storyId: number, idempotencyKey: string, lastError = 'boom') => {
    const now = new Date(NOW);
    dbHolder.db
      .insert(durableJobs)
      .values({
        kind: 'implement',
        slot: 'heavy',
        storyId,
        payload: {},
        sideEffecting: true,
        status: 'failed',
        runAfter: now,
        idempotencyKey,
        lastError,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  };

  test('re-fires verification_passed for a TESTING story whose passed evidence never landed', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s2-pass' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-1', title: 'Crashed after pass', status: 'TESTING', candidateSha: SHA, candidateTree: TREE });
    seedPassedVerification(story.id);

    try {
      const summary = sweepStuckStories(deps);

      expect(summary).toMatchObject({ refired: 1, blocked: 0, enqueued: 0 });
      expect(storyRow(story.id).status).toBe('READY_FOR_REVIEW');
    } finally {
      // Hygiene: a non-terminal story with no job would keep being swept by later tests.
      forceStory(dbHolder.db, story.id, { cancelledAt: new Date() });
    }
  });

  test('re-fires review_approved for a READY_FOR_REVIEW story with a landed approved review', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s2-approve' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-2', title: 'Crashed after review', status: 'READY_FOR_REVIEW', candidateSha: SHA, candidateTree: TREE });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id);
    seedPassedVerification(story.id);
    try {
      const review = seedReview(story.id, 'APPROVED');
      dbHolder.db.insert(reviewAcResults).values({ reviewId: review.id, acceptanceCriterionId: ac.id, status: 'met', evidence: 'Seeded acceptance evidence' }).run();

      const summary = sweepStuckStories(deps);

      expect(summary).toMatchObject({ refired: 1, blocked: 0, enqueued: 0 });
      expect(storyRow(story.id).status).toBe('AWAITING_MERGE');
    } finally {
      forceStory(dbHolder.db, story.id, { cancelledAt: new Date() });
    }
  });

  test('a re-fired review_changes_requested with an exhausted budget blocks retry_limit', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s2-changes' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'SWP-3',
      title: 'Changes without budget',
      status: 'READY_FOR_REVIEW',
      candidateSha: SHA,
      candidateTree: TREE,
      attemptCount: 3,
      maxAttempts: 3,
    });
    seedReview(story.id, 'CHANGES_REQUESTED');

    const summary = sweepStuckStories(deps);

    const updated = storyRow(story.id);
    expect(summary).toMatchObject({ blocked: 1, refired: 0 });
    expect(updated).toMatchObject({ status: 'BLOCKED', blockedReason: 'retry_limit', blockedFrom: 'READY_FOR_REVIEW' });
    expect(updated.blockedDetail).toContain('attempts');
  });

  test('a NEW planning_failed story with a spent planning budget blocks invalid_agent_output from NEW', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s3-plan' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-4', title: 'Unplannable', status: 'NEW', planningStatus: 'planning_failed' });
    for (let i = 0; i < 3; i += 1) {
      dbHolder.db
        .insert(agentRuns)
        .values({
          storyId: story.id,
          role: 'planner',
          attempt: i + 1,
          promptVersion: '1.0',
          opencodeVersion: '2.0.32',
          status: 'failed',
          exitReason: 'The model returned no text',
          idempotencyKey: `sweep_plan_${story.id}_${i}`,
          startedAt: new Date(NOW),
          endedAt: new Date(NOW),
        })
        .run();
    }

    const summary = sweepStuckStories(deps);

    const updated = storyRow(story.id);
    expect(summary).toMatchObject({ blocked: 1 });
    expect(updated).toMatchObject({ status: 'BLOCKED', blockedReason: 'invalid_agent_output', blockedFrom: 'NEW' });
    expect(updated.blockedDetail).toContain('3');
  });

  test('an IN_PROGRESS story with a still-running run marks the run interrupted, emits run.finished and blocks', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s4-running' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-5', title: 'Orphaned run', status: 'IN_PROGRESS' });
    const run = dbHolder.db
      .insert(agentRuns)
      .values({
        storyId: story.id,
        role: 'implementer',
        attempt: 1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status: 'running',
        idempotencyKey: `sweep_run_${story.id}`,
        startedAt: new Date(NOW),
      })
      .returning()
      .get();
    forceStory(dbHolder.db, story.id, { activeRunId: run.id });

    const summary = sweepStuckStories(deps);

    expect(summary).toMatchObject({ blocked: 1 });
    expect(dbHolder.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()).toMatchObject({
      status: 'interrupted',
      exitReason: 'Orphaned by integrity sweep',
      endedAt: new Date(NOW),
    });
    expect(storyRow(story.id)).toMatchObject({ status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null });
    const finished = dbHolder.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.topic, 'run.finished'), eq(outboxEvents.storyId, story.id)))
      .all();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload.data).toMatchObject({ runId: run.id, status: 'interrupted', exitReason: 'Orphaned by integrity sweep' });
  });

  test('an IN_PROGRESS story with no active run blocks with environment (run lost before it started)', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-s4-lost' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-6', title: 'Run never started', status: 'IN_PROGRESS', activeRunId: null });

    const summary = sweepStuckStories(deps);

    const updated = storyRow(story.id);
    expect(summary).toMatchObject({ blocked: 1 });
    expect(updated).toMatchObject({ status: 'BLOCKED', blockedReason: 'environment', blockedFrom: 'IN_PROGRESS' });
    expect(updated.blockedDetail).toContain('run lost before it started');
  });

  test('leaves AWAITING_MERGE, held stories and stories with a queued job untouched', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-exempt' });
    const merge = seedStory(dbHolder.db, project.id, { key: 'SWP-7', title: 'Waiting for approval', status: 'AWAITING_MERGE', candidateSha: SHA, candidateTree: TREE });
    const held = seedStory(dbHolder.db, project.id, { key: 'SWP-8', title: 'On hold', status: 'READY', planningStatus: 'plan_approved', hold: true });
    const busy = seedStory(dbHolder.db, project.id, { key: 'SWP-9', title: 'Job in flight', status: 'TESTING', candidateSha: SHA, candidateTree: TREE });
    queue.enqueue({ kind: 'verify', slot: 'heavy', storyId: busy.id, sideEffecting: false, idempotencyKey: `sweep_busy_${busy.id}` });

    try {
      const summary = sweepStuckStories(deps);

      expect(summary).toMatchObject({ blocked: 0, enqueued: 0, refired: 0, skipped: 2 });
      expect(storyRow(merge.id).status).toBe('AWAITING_MERGE');
      expect(storyRow(held.id).status).toBe('READY');
      expect(storyRow(busy.id).status).toBe('TESTING');
      const busyJobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, busy.id)).all();
      expect(busyJobs).toHaveLength(1);
      expect(busyJobs[0]?.status).toBe('queued');
      for (const s of [merge, held, busy]) {
        expect(dbHolder.db.select().from(storyEvents).where(eq(storyEvents.storyId, s.id)).all()).toHaveLength(0);
      }
    } finally {
      forceStory(dbHolder.db, merge.id, { cancelledAt: new Date() });
      forceStory(dbHolder.db, held.id, { cancelledAt: new Date() });
      forceStory(dbHolder.db, busy.id, { cancelledAt: new Date() });
    }
  });

  test('re-enqueues a failed rework stage round once and records exactly one retry event', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-rework-retry' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'SWP-10',
      title: 'Repair retry',
      status: 'TESTING',
      candidateSha: SHA,
      candidateTree: TREE,
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedFailedVerification(story.id);
    seedFailedStageJob(story.id, `rework_${story.id}_${SHA}_0_r0`);

    try {
      const first = sweepStuckStories(deps);

      expect(first).toMatchObject({ enqueued: 1, blocked: 0 });
      const retry = dbHolder.db
        .select()
        .from(durableJobs)
        .where(eq(durableJobs.idempotencyKey, `rework_${story.id}_${SHA}_0_r1`))
        .get();
      expect(retry).toMatchObject({ storyId: story.id, kind: 'implement', status: 'queued', sideEffecting: true });
      const rows = internalErrorRows(story.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ message: 'stage retried: rework r1', stage: 'rework', ordinal: 1 });

      // The retried job is queued now, so a second sweep must neither enqueue again nor repeat the event.
      const second = sweepStuckStories(deps);
      expect(second).toMatchObject({ skipped: 1, enqueued: 0 });
      expect(internalErrorRows(story.id)).toHaveLength(1);
    } finally {
      forceStory(dbHolder.db, story.id, { cancelledAt: new Date() });
    }
  });

  test('a re-fire rejected by non-attempts guards records one informational row and skips the story for this process', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-refire-guard' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-11', title: 'Evidence mismatch', status: 'READY_FOR_REVIEW', candidateSha: SHA, candidateTree: TREE });
    seedPassedVerification(story.id);
    const review = seedReview(story.id, 'APPROVED');
    dbHolder.db
      .insert(reviewFindings)
      .values({
        reviewId: review.id,
        findingKey: 'F-1',
        severity: 'high',
        category: 'correctness',
        evidence: 'The value is wrong',
        explanation: 'The approved candidate computes the wrong total',
        recommendation: 'Fix the summation',
        blocking: true,
      })
      .run();

    try {
      const first = sweepStuckStories(deps);

      expect(first).toMatchObject({ skipped: 1, refired: 0, blocked: 0 });
      expect(storyRow(story.id).status).toBe('READY_FOR_REVIEW');
      const rows = internalErrorRows(story.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ message: 'integrity re-fire rejected by guards' });

      const second = sweepStuckStories(deps);
      expect(second).toMatchObject({ skipped: 1 });
      expect(internalErrorRows(story.id)).toHaveLength(1);
    } finally {
      forceStory(dbHolder.db, story.id, { cancelledAt: new Date() });
    }
  });

  test('a leased implement job shields a live IN_PROGRESS story from the sweep', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/sweep-leased' });
    const story = seedStory(dbHolder.db, project.id, { key: 'SWP-12', title: 'Live run', status: 'IN_PROGRESS' });
    const run = dbHolder.db
      .insert(agentRuns)
      .values({
        storyId: story.id,
        role: 'implementer',
        attempt: 1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status: 'running',
        idempotencyKey: `sweep_live_${story.id}`,
        startedAt: new Date(NOW),
      })
      .returning()
      .get();
    forceStory(dbHolder.db, story.id, { activeRunId: run.id });
    const slot = heavyLane('C:/repos/sweep-leased');
    queue.enqueue({ kind: 'implement', slot, storyId: story.id, sideEffecting: true, idempotencyKey: `sweep_leased_${story.id}` });
    expect(queue.claim(slot)?.kind).toBe('implement');

    try {
      const summary = sweepStuckStories(deps);

      expect(summary).toMatchObject({ blocked: 0, enqueued: 0, refired: 0, skipped: 1 });
      expect(storyRow(story.id).status).toBe('IN_PROGRESS');
      expect(dbHolder.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()).toMatchObject({ status: 'running' });
      const finished = dbHolder.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.topic, 'run.finished'), eq(outboxEvents.storyId, story.id)))
        .all();
      expect(finished).toHaveLength(0);
    } finally {
      forceStory(dbHolder.db, story.id, { cancelledAt: new Date() });
    }
  });
});
