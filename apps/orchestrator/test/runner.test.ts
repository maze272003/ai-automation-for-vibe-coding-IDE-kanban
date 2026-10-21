import { agentRuns, durableJobs, mergeApprovals, userStories } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ImplementerAgent } from '../src/agents/implementer.ts';
import type { PlannerAgent } from '../src/agents/planner.ts';
import type { ReviewerAgent } from '../src/agents/reviewer.ts';
import { AgentRunner } from '../src/agents/runner.ts';
import type { ApproveAndMergeStoryInput, LocalMerger } from '../src/git/merger.ts';
import type { VerificationRunner } from '../src/verify/runner.ts';
import { EventBus } from '../src/events/bus.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedPlan, seedProject, seedStory } from './helpers/db.ts';

describe('AgentRunner', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let queue: JobQueue;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    queue = new JobQueue(dbHolder.db);
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('processes plan job and delegates to PlannerAgent', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-runner' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Runner Plan Test',
      status: 'NEW',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true, planId: 1 }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true, candidateSha: 'abcdef' }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
      verification: { verifyStory: vi.fn() } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn() } as unknown as ReviewerAgent,
    });

    queue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_plan_${story.id}`,
    });

    await runner.tick();

    expect(mockPlanner.planStory).toHaveBeenCalledWith({ storyId: story.id });

    const jobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    const planJob = jobs.find((j) => j.kind === 'plan');
    expect(planJob?.status).toBe('succeeded');
  });

  test('processes implement job and delegates to ImplementerAgent', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-impl' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Runner Implement Test',
      status: 'READY',
      planningStatus: 'plan_approved',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true, candidateSha: '1234567890abcdef' }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
      verification: { verifyStory: vi.fn() } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn() } as unknown as ReviewerAgent,
    });

    queue.enqueue({
      kind: 'implement',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: true,
      idempotencyKey: `test_impl_${story.id}`,
    });

    await runner.tick();

    expect(mockImplementer.implementStory).toHaveBeenCalledWith({ storyId: story.id });

    const jobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    const implJob = jobs.find((j) => j.kind === 'implement');
    expect(implJob?.status).toBe('succeeded');
  });

  test('auto-enqueues plan job for newly discovered un-planned story in NEW', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-auto' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Auto Enqueue Test',
      status: 'NEW',
      planningStatus: 'none',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
      verification: { verifyStory: vi.fn() } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn() } as unknown as ReviewerAgent,
    });

    await runner.tick();

    expect(mockPlanner.planStory).toHaveBeenCalledWith({ storyId: story.id });
  });

  const runnerWith = (overrides: {
    planner?: Partial<PlannerAgent>;
    implementer?: Partial<ImplementerAgent>;
    verification?: Partial<VerificationRunner>;
    reviewer?: Partial<ReviewerAgent>;
    merger?: Partial<LocalMerger>;
    heartbeatMs?: number;
  } = {}) =>
    new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: { planStory: vi.fn().mockResolvedValue({ ok: true }), ...overrides.planner } as unknown as PlannerAgent,
      implementer: { implementStory: vi.fn().mockResolvedValue({ ok: true }), ...overrides.implementer } as unknown as ImplementerAgent,
      verification: { verifyStory: vi.fn().mockResolvedValue({ ok: true, status: 'passed' }), ...overrides.verification } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn().mockResolvedValue({ ok: true }), ...overrides.reviewer } as unknown as ReviewerAgent,
      merger: overrides.merger as unknown as LocalMerger | undefined,
      heartbeatMs: overrides.heartbeatMs,
    });

  test('auto-enqueues a re-plan job for a NEW story returned to planningStatus=planning, keyed by the next plan version', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'RPL-1',
      title: 'Rejected once',
      status: 'NEW',
      planningStatus: 'planning',
    });
    seedPlan(dbHolder.db, story.id, { version: 1, status: 'rejected', rejectionFeedback: 'too broad' });

    const planStory = vi.fn().mockResolvedValue({ ok: true });
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    await runner.tick();

    expect(planStory).toHaveBeenCalledWith({ storyId: story.id });
    const planJobs = dbHolder.db
      .select()
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
      .all();
    expect(planJobs).toHaveLength(1);
    expect(planJobs[0]?.idempotencyKey).toBe(`auto_plan_${story.id}_${story.revision}_v2_a0`);
    expect(planJobs[0]?.status).toBe('succeeded');

    // Hygiene: stop later ticks from re-planning this story.
    dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
  });

  test('first plan of a planningStatus=none story still enqueues with the versioned v1 key', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan-v1' });
    const story = seedStory(dbHolder.db, project.id, { key: 'RPL-2', title: 'Fresh story', status: 'NEW', planningStatus: 'none' });

    const runner = runnerWith({});

    await runner.tick();

    const planJobs = dbHolder.db
      .select()
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
      .all();
    expect(planJobs).toHaveLength(1);
    expect(planJobs[0]?.idempotencyKey).toBe(`auto_plan_${story.id}_${story.revision}_v1_a0`);

    // Hygiene: stop later ticks from re-planning this story.
    dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
  });

  test('retries a story whose planning failed, with a new job key, and stops after the planning budget', async () => {
    // A failed plan used to park the story in NEW/planning_failed forever: the only recovery
    // path (`recover`) needs BLOCKED, so the board silently stopped working on the story.
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-plan-retry' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'RPL-7',
      title: 'Failed plan',
      status: 'NEW',
      planningStatus: 'planning_failed',
    });
    const failedRun = dbHolder.db
      .insert(agentRuns)
      .values({
        storyId: story.id,
        role: 'planner',
        attempt: 1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        inputSha: 'a'.repeat(40),
        status: 'failed',
        exitReason: 'The model returned no text',
        idempotencyKey: `plan_failed_${story.id}`,
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning()
      .get();
    expect(failedRun.id).toBeGreaterThan(0);

    const planStory = vi.fn().mockResolvedValue({ ok: true });
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    await runner.tick();

    expect(planStory).toHaveBeenCalledWith({ storyId: story.id });
    const planJobs = dbHolder.db
      .select()
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
      .all();
    expect(planJobs).toHaveLength(1);
    // The retry is a new job: the key carries the failed-attempt counter.
    expect(planJobs[0]?.idempotencyKey).toBe(`auto_plan_${story.id}_${story.revision}_v1_a1`);
    expect(planJobs[0]?.status).toBe('succeeded');

    // Hygiene: stop later ticks from re-planning this story.
    dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
  });

  test('stops retrying a story whose planning failed once the planning budget is spent', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-plan-budget' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'RPL-8',
      title: 'Permanently broken plan',
      status: 'NEW',
      planningStatus: 'planning_failed',
    });
    for (let i = 0; i < 3; i += 1) {
      dbHolder.db
        .insert(agentRuns)
        .values({
          storyId: story.id,
          role: 'planner',
          attempt: i + 1,
          promptVersion: '1.0',
          opencodeVersion: '2.0.32',
          inputSha: 'a'.repeat(40),
          status: 'failed',
          exitReason: 'The model returned no text',
          idempotencyKey: `plan_failed_${story.id}_${i}`,
          startedAt: new Date(),
          endedAt: new Date(),
        })
        .run();
    }

    const planStory = vi.fn();
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    await runner.tick();

    expect(planStory).not.toHaveBeenCalled();
    const planJobs = dbHolder.db
      .select()
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
      .all();
    expect(planJobs).toHaveLength(0);
  });

  test('does not enqueue a second plan job for a planning story while one is queued or leased', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan-dedupe' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'RPL-3',
      title: 'In-flight re-plan',
      status: 'NEW',
      planningStatus: 'planning',
    });
    seedPlan(dbHolder.db, story.id, { version: 1, status: 'rejected', rejectionFeedback: 'nope' });

    const { id: jobId } = queue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_replan_inflight_${story.id}`,
    });
    // Simulate another worker holding the plan job: it is leased (active), not queued.
    const leased = queue.claim('heavy');
    expect(leased?.id).toBe(jobId);

    const planStory = vi.fn();
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    try {
      await runner.tick();

      // Discovery saw the active (leased) plan job and must not add another; the busy heavy
      // slot means this runner cannot claim anything, so its planner never runs.
      const planJobs = dbHolder.db
        .select()
        .from(durableJobs)
        .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
        .all();
      expect(planJobs).toHaveLength(1);
      expect(planJobs[0]?.id).toBe(jobId);
      expect(planJobs[0]?.status).toBe('leased');
      expect(planStory).not.toHaveBeenCalled();
    } finally {
      // Hygiene: release the heavy slot and stop later ticks from re-planning this story.
      queue.complete(leased!.id, leased!.leaseToken);
      dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
    }
  });

  test('after another reject lands, the next re-plan enqueues with a different version key', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan-v3' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'RPL-4',
      title: 'Rejected twice',
      status: 'NEW',
      planningStatus: 'planning',
    });
    seedPlan(dbHolder.db, story.id, { version: 1, status: 'rejected', rejectionFeedback: 'first' });

    const planStory = vi.fn().mockResolvedValue({ ok: true });
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    await runner.tick(); // re-plan v2 (the mock planner does not persist a plan row itself)

    // The planner saved v2 and the human rejected it again: another plans row + back to planning.
    seedPlan(dbHolder.db, story.id, { version: 2, status: 'rejected', rejectionFeedback: 'second' });
    forceStory(dbHolder.db, story.id, { planningStatus: 'planning' });

    await runner.tick(); // re-plan v3 — a different key, so it really enqueues

    const keys = dbHolder.db
      .select({ key: durableJobs.idempotencyKey })
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'plan')))
      .all()
      .map((row) => row.key)
      .sort();
    expect(keys).toEqual([`auto_plan_${story.id}_${story.revision}_v2_a0`, `auto_plan_${story.id}_${story.revision}_v3_a0`]);
    expect(planStory).toHaveBeenCalledTimes(2);

    // Hygiene: stop later ticks from re-planning this story.
    dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
  });

  test('a needs_clarification story enqueues no plan job', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-replan-excluded' });
    const waiting = seedStory(dbHolder.db, project.id, { key: 'RPL-6', title: 'Awaiting answers', status: 'NEW', planningStatus: 'needs_clarification' });
    // An existing plan row proves the exclusion comes from the planning status, not from having
    // nothing to re-plan.
    seedPlan(dbHolder.db, waiting.id, { version: 1, status: 'proposed' });

    const planStory = vi.fn();
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });

    await runner.tick();

    const planJobs = dbHolder.db
      .select()
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, waiting.id), eq(durableJobs.kind, 'plan')))
      .all();
    expect(planJobs).toHaveLength(0);
    expect(planStory).not.toHaveBeenCalledWith({ storyId: waiting.id });
  });

  test('discovers a TESTING story and runs verification once per candidate', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-verify' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'AUT-1',
      title: 'Verify auto',
      status: 'TESTING',
      candidateSha: 'a'.repeat(40),
      candidateTree: 'b'.repeat(40),
    });
    const verifyStory = vi.fn().mockResolvedValue({ ok: true, status: 'passed' });
    const runner = runnerWith({ verification: { verifyStory } as unknown as VerificationRunner });

    await runner.tick();
    await runner.tick();

    expect(verifyStory).toHaveBeenCalledWith({ storyId: story.id });
    const jobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all().filter((j) => j.kind === 'verify');
    expect(jobs).toHaveLength(1);
  });

  test('turns a failed verification into a repair implement job', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-repair' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'AUT-2',
      title: 'Repair auto',
      status: 'TESTING',
      candidateSha: 'c'.repeat(40),
      candidateTree: 'd'.repeat(40),
      attemptCount: 1,
      maxAttempts: 3,
    });
    const { verificationRuns } = await import('@aik/db');
    dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: story.candidateSha!, trigger: 'candidate', status: 'failed', startedAt: new Date(), endedAt: new Date() })
      .run();
    const implementStory = vi.fn().mockResolvedValue({ ok: true });
    const runner = runnerWith({ implementer: { implementStory } as unknown as ImplementerAgent });

    await runner.tick();

    expect(implementStory).toHaveBeenCalledWith({ storyId: story.id });
  });

  test('blocks with retry_limit instead of enqueueing a repair when the budget is exhausted', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-exhausted' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'AUT-3',
      title: 'Exhausted auto',
      status: 'TESTING',
      candidateSha: 'e'.repeat(40),
      candidateTree: 'f'.repeat(40),
      attemptCount: 3,
      maxAttempts: 3,
    });
    const { verificationRuns } = await import('@aik/db');
    dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: story.candidateSha!, trigger: 'candidate', status: 'failed', startedAt: new Date(), endedAt: new Date() })
      .run();
    const implementStory = vi.fn();
    const runner = runnerWith({ implementer: { implementStory } as unknown as ImplementerAgent });

    await runner.tick();

    expect(implementStory).not.toHaveBeenCalled();
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('retry_limit');
  });

  test('discovers a READY_FOR_REVIEW story and runs the reviewer', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-review' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'AUT-4',
      title: 'Review auto',
      status: 'READY_FOR_REVIEW',
      candidateSha: '1'.repeat(40),
      candidateTree: '2'.repeat(40),
    });
    const reviewStory = vi.fn().mockResolvedValue({ ok: true, verdict: 'APPROVED' });
    const runner = runnerWith({ reviewer: { reviewStory } as unknown as ReviewerAgent });

    await runner.tick();

    expect(reviewStory).toHaveBeenCalledWith({ storyId: story.id });
  });

  test('completes a merge job as stale, without merging, when payload.sha is not the current candidate', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-merge-stale-sha' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-1',
      title: 'Stale merge payload',
      status: 'AWAITING_MERGE',
      candidateSha: 'a'.repeat(40),
      candidateTree: 'b'.repeat(40),
    });
    const approveAndMergeStory = vi.fn().mockResolvedValue({ ok: true, mergedSha: 'a'.repeat(40) });
    const runner = runnerWith({ merger: { approveAndMergeStory } as unknown as LocalMerger });

    const { id: jobId } = queue.enqueue({
      kind: 'merge',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: true,
      payload: { sha: 'c'.repeat(40), approvalId: 12345 },
      idempotencyKey: `test_merge_stale_sha_${story.id}`,
    });

    await runner.tick();

    expect(approveAndMergeStory).not.toHaveBeenCalled();
    const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
    expect(job?.status).toBe('succeeded');
    expect(job?.lastError).toBeNull();
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('AWAITING_MERGE');
  });

  test('completes a merge job as stale, without merging, when payload.approvalId has no matching approval row', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-merge-stale-approval' });
    const candidate = 'd'.repeat(40);
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-2',
      title: 'Missing approval row',
      status: 'AWAITING_MERGE',
      candidateSha: candidate,
      candidateTree: 'e'.repeat(40),
    });
    const approveAndMergeStory = vi.fn().mockResolvedValue({ ok: true, mergedSha: candidate });
    const runner = runnerWith({ merger: { approveAndMergeStory } as unknown as LocalMerger });

    const { id: jobId } = queue.enqueue({
      kind: 'merge',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: true,
      payload: { sha: candidate, approvalId: 999_999 },
      idempotencyKey: `test_merge_stale_approval_${story.id}`,
    });

    await runner.tick();

    expect(approveAndMergeStory).not.toHaveBeenCalled();
    const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
    expect(job?.status).toBe('succeeded');
    expect(job?.lastError).toBeNull();
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('AWAITING_MERGE');
  });

  test('forwards assertLease to the merger and fails the job with the lease-lost error when the lease is gone', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-merge-lease' });
    const candidate = 'f'.repeat(40);
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-3',
      title: 'Lease lost mid-merge',
      status: 'AWAITING_MERGE',
      candidateSha: candidate,
      candidateTree: '0'.repeat(40),
    });
    const approval = dbHolder.db
      .insert(mergeApprovals)
      .values({ storyId: story.id, kind: 'merge', commitSha: candidate, approver: 'local-user', approvedAt: new Date() })
      .returning()
      .get();

    const { id: jobId } = queue.enqueue({
      kind: 'merge',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: true,
      payload: { sha: candidate, approvalId: approval.id },
      idempotencyKey: `test_merge_lease_${story.id}`,
    });

    let capturedAssertLease: (() => boolean) | undefined;
    const approveAndMergeStory = vi.fn(
      async (input: ApproveAndMergeStoryInput): Promise<{ ok: boolean; mergedSha?: string; error?: string }> => {
        capturedAssertLease = input.assertLease;
        // Simulate another worker taking over the lease while the merge is running.
        dbHolder.db.update(durableJobs).set({ leaseToken: 'stolen-by-another-worker' }).where(eq(durableJobs.id, jobId)).run();
        if (input.assertLease && !input.assertLease()) {
          return { ok: false, error: 'The merge job lease was lost; the merge stopped before advancing the base ref' };
        }
        return { ok: true, mergedSha: candidate };
      },
    );
    const runner = runnerWith({ merger: { approveAndMergeStory } as unknown as LocalMerger });
    const failSpy = vi.spyOn(queue, 'fail');

    try {
      await runner.tick();

      expect(capturedAssertLease).toBeTypeOf('function');
      expect(capturedAssertLease!()).toBe(false);
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).toHaveBeenCalledWith(jobId, expect.any(String), 'The merge job lease was lost; the merge stopped before advancing the base ref', { retry: false });
      // The stolen lease means the runner cannot complete the job either — it must not report success.
      const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      expect(job?.status).toBe('leased');
      expect(job?.lastError).toBeNull();
      const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
      expect(updated?.status).toBe('AWAITING_MERGE');
    } finally {
      failSpy.mockRestore();
      // Free the heavy slot for later tests: model the crash-recovery sweep taking over the
      // stolen lease (side-effecting job → failed/interrupted, never silently re-run).
      dbHolder.db.update(durableJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(durableJobs.id, jobId)).run();
      queue.sweepExpired();
    }
  });

  test('keeps the merge job lease alive with repeated heartbeats while the merger runs', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-merge-heartbeat' });
    const candidate = '1'.repeat(40);
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-4',
      title: 'Long merge heartbeat',
      status: 'AWAITING_MERGE',
      candidateSha: candidate,
      candidateTree: '2'.repeat(40),
    });
    // The merger blocks until the test releases it, so the only thing that can renew the lease is
    // the runner's heartbeat interval. Fake timers make the 5s-interval timing deterministic.
    let releaseMerger: () => void = () => undefined;
    const mergerDone = new Promise<void>((resolve) => {
      releaseMerger = resolve;
    });
    const approveAndMergeStory = vi.fn(async () => {
      await mergerDone;
      return { ok: true, mergedSha: candidate };
    });
    // Legacy payload (no sha/approvalId) on purpose: it must fall through to the merger's own guard.
    const runner = runnerWith({ merger: { approveAndMergeStory } as unknown as LocalMerger, heartbeatMs: 5_000 });
    const heartbeatSpy = vi.spyOn(queue, 'heartbeat');

    vi.useFakeTimers();
    try {
      const { id: jobId } = queue.enqueue({
        kind: 'merge',
        slot: 'heavy',
        storyId: story.id,
        sideEffecting: true,
        payload: {},
        idempotencyKey: `test_merge_heartbeat_${story.id}`,
      });

      const tickPromise = runner.tick();
      // 12s of virtual time with the merger still running: the 5s interval must fire twice.
      await vi.advanceTimersByTimeAsync(12_000);
      releaseMerger();
      await tickPromise;

      expect(approveAndMergeStory).toHaveBeenCalledTimes(1);
      const renewals = heartbeatSpy.mock.calls.filter(([id]) => id === jobId).length;
      expect(renewals).toBeGreaterThanOrEqual(2);
      const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      expect(job?.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
      heartbeatSpy.mockRestore();
      releaseMerger();
    }
  });

  test('heartbeats the lease during a handler longer than the lease, keeping the job claimable only by its holder', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-heartbeat-plan' });
    const story = seedStory(dbHolder.db, project.id, { key: 'HB-1', title: 'Long plan heartbeat', status: 'NEW' });
    const leaseMs = 10_000;
    // A queue whose lease is shorter than the handler, plus a rival worker sharing the database.
    const shortLeaseQueue = new JobQueue(dbHolder.db, { leaseMs });
    const rival = new JobQueue(dbHolder.db, { leaseMs });

    const { id: jobId } = shortLeaseQueue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_plan_heartbeat_${story.id}`,
    });

    const observed: {
      heartbeatAtClaim: number;
      heartbeatAtMidRun: number;
      leaseExpiresAtMidRun: number;
      midRunClaim: ReturnType<JobQueue['claim']>;
      midRunSweep: ReturnType<JobQueue['sweepExpired']>;
    } = {
      heartbeatAtClaim: 0,
      heartbeatAtMidRun: 0,
      leaseExpiresAtMidRun: 0,
      midRunClaim: null,
      midRunSweep: { requeued: [], dead: [], interrupted: [] },
    };

    // The planner blocks until the test releases it, so only the runner's heartbeat interval
    // can keep the lease alive while virtual time advances past the original lease expiry.
    let releasePlanner: () => void = () => undefined;
    const plannerDone = new Promise<void>((resolve) => {
      releasePlanner = resolve;
    });
    const planStory = vi.fn(async () => {
      observed.heartbeatAtClaim = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get()?.heartbeatAt?.getTime() ?? 0;
      await plannerDone;
      const midRun = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      observed.heartbeatAtMidRun = midRun?.heartbeatAt?.getTime() ?? 0;
      observed.leaseExpiresAtMidRun = midRun?.leaseExpiresAt?.getTime() ?? 0;
      observed.midRunClaim = rival.claim('heavy');
      observed.midRunSweep = shortLeaseQueue.sweepExpired();
      return { ok: true };
    });

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue: shortLeaseQueue,
      workflow,
      bus,
      planner: { planStory } as unknown as PlannerAgent,
      implementer: { implementStory: vi.fn().mockResolvedValue({ ok: true }) } as unknown as ImplementerAgent,
      verification: { verifyStory: vi.fn().mockResolvedValue({ status: 'passed' }) } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn().mockResolvedValue({ ok: true }) } as unknown as ReviewerAgent,
      heartbeatMs: 3_000,
    });

    vi.useFakeTimers();
    try {
      const tickPromise = runner.tick();
      // 15s of virtual time with the planner still running — past the 10s lease it was
      // granted at claim time. The 3s heartbeat interval must fire at 3/6/9/12/15s.
      await vi.advanceTimersByTimeAsync(15_000);
      releasePlanner();
      await tickPromise;

      expect(planStory).toHaveBeenCalledWith({ storyId: story.id });
      // Heartbeats advanced both the beat timestamp and the lease expiry past the original
      // claim-window (t0 + leaseMs), which is what keeps the handler's work claimable.
      expect(observed.heartbeatAtMidRun).toBeGreaterThan(observed.heartbeatAtClaim);
      expect(observed.leaseExpiresAtMidRun).toBeGreaterThan(observed.heartbeatAtClaim + leaseMs);
      // So while the handler was still running, a rival worker could neither claim the heavy
      // slot nor sweep the live lease away as expired.
      expect(observed.midRunClaim).toBeNull();
      expect(observed.midRunSweep).toEqual({ requeued: [], dead: [], interrupted: [] });
      const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      expect(job?.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
      releasePlanner();
      // Hygiene: stop later ticks from auto-planning this still-NEW story.
      dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
    }
  });

  test('a lost lease means complete() lands false and no implement follow-up is enqueued after the plan job', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-heartbeat-lost-lease' });
    const story = seedStory(dbHolder.db, project.id, { key: 'HB-2', title: 'Lease lost mid-plan', status: 'NEW' });

    const planStory = vi.fn(async (input: { storyId: number }) => {
      // Planning "succeeds": the story becomes READY… but the job row is cancelled mid-handler
      // (as cancel_jobs does for leased rows), so the runner's completion cannot land.
      dbHolder.db.update(userStories).set({ status: 'READY', statusVersion: 2 }).where(eq(userStories.id, input.storyId)).run();
      queue.cancelForStory(input.storyId);
      return { ok: true };
    });
    const runner = runnerWith({ planner: { planStory } as unknown as PlannerAgent });
    const completeSpy = vi.spyOn(queue, 'complete');

    const { id: jobId } = queue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_plan_lost_lease_${story.id}`,
    });

    try {
      await runner.tick();

      // The handler always runs to completion — a lost lease never aborts it mid-flight.
      expect(planStory).toHaveBeenCalledTimes(1);
      const callIndex = completeSpy.mock.calls.findIndex(([id]) => id === jobId);
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(completeSpy.mock.results[callIndex]?.value).toBe(false);
      // The cancelled row stays cancelled (the completion did not land)…
      const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      expect(job?.status).toBe('cancelled');
      // …and although the story is READY — so a follow-up would otherwise be enqueued — no
      // implement job exists (spec §16.6 I9: a stale worker never produces follow-up jobs).
      const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
      expect(updated?.status).toBe('READY');
      const implementJobs = dbHolder.db
        .select()
        .from(durableJobs)
        .where(and(eq(durableJobs.storyId, story.id), eq(durableJobs.kind, 'implement')))
        .all();
      expect(implementJobs).toHaveLength(0);
    } finally {
      completeSpy.mockRestore();
      // Hygiene: a READY story would be discovered by later ticks.
      dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
    }
  });

  test('clears the heartbeat interval when the handler ends — no timer keeps beating between jobs', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-heartbeat-no-leak' });
    const story = seedStory(dbHolder.db, project.id, { key: 'HB-3', title: 'No heartbeat leak', status: 'NEW' });
    const heartbeatSpy = vi.spyOn(queue, 'heartbeat');
    const runner = runnerWith({ heartbeatMs: 10 });

    const { id: jobId } = queue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_plan_no_leak_${story.id}`,
    });

    vi.useFakeTimers();
    try {
      // The instant handler runs entirely at frozen time t0, so no beat can fire mid-run; the
      // interval must already be cleared by the time tick() resolves.
      await runner.tick();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(heartbeatSpy.mock.calls.filter(([id]) => id === jobId)).toHaveLength(0);
      const job = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, jobId)).get();
      expect(job?.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
      heartbeatSpy.mockRestore();
      dbHolder.db.update(userStories).set({ cancelledAt: new Date() }).where(eq(userStories.id, story.id)).run();
    }
  });
});
