// apps/orchestrator/test/run-interruption.test.ts
// Cross-cutting integration coverage for the run-interruption plan (EXE-13): stop_run/cancel
// actually stop in-flight work at the service layer — the interrupt hook fires post-commit from
// both transition entry points, the registry stops the registered session, the agent run ends
// 'interrupted' without consuming an attempt, and cancel_jobs clears queued AND leased rows so
// discovery never re-enqueues a cancelled story.
import { agentRuns, durableJobs, storyEvents } from '@aik/db';
import { and, desc, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';
import { ImplementerAgent } from '../src/agents/implementer.ts';
import type { PlannerAgent } from '../src/agents/planner.ts';
import type { ReviewerAgent } from '../src/agents/reviewer.ts';
import { AgentRunner } from '../src/agents/runner.ts';
import type { OpenCodeRuntime, RunOneShotInput, RunOneShotOutput } from '../src/agents/runtime.ts';
import { ApiHttpError } from '../src/api/errors.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { StoryService } from '../src/stories/service.ts';
import { getStoryRow } from '../src/workflow/snapshot.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import type { VerificationRunner } from '../src/verify/runner.ts';
import { createTestDb, forceStory, seedPlan, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Polls `cond` every 5 ms until truthy; false when `deadlineMs` elapses first (bounded patience, no long real waits). */
async function waitUntil(cond: () => boolean, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await sleep(5);
  }
  return true;
}

/** What `onRunInterrupt` observed when it fired — it must see committed state, never in-transaction state. */
interface HookObservation {
  storyId: number;
  /** Undefined for story-scoped interrupts (e.g. a stop during verification). */
  runId?: number;
  storyStatus: string;
  storyVersion: number;
  activeRunId: number | null;
  blockedReason: string | null;
  lastTransitionTo: string | null;
}

let runCounter = 0;

describe('run interruption (EXE-13) — cross-cutting, service layer', () => {
  let t: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    t = createTestDb();
    return () => t.close();
  });

  const jobsForStory = (storyId: number) => t.db.select().from(durableJobs).where(eq(durableJobs.storyId, storyId)).all();

  /** Seeds a running agent run (no story link yet) and returns its id. */
  const seedActiveRun = (storyId: number) => {
    runCounter += 1;
    return t.db
      .insert(agentRuns)
      .values({ storyId, role: 'implementer', attempt: 1, promptVersion: '1.0', opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `ri-run-${runCounter}`, startedAt: new Date() })
      .returning()
      .get().id;
  };

  /** Reads the story row and the latest transition audit row the moment the hook fires. */
  const observe = (storyId: number, runId?: number): HookObservation => {
    const row = getStoryRow(t.db, storyId);
    const lastTransition = t.db
      .select({ to: storyEvents.toStatus })
      .from(storyEvents)
      .where(and(eq(storyEvents.storyId, storyId), eq(storyEvents.type, 'transition')))
      .orderBy(desc(storyEvents.id))
      .limit(1)
      .get();
    return {
      storyId,
      runId,
      storyStatus: row?.status ?? '??',
      storyVersion: row?.statusVersion ?? -1,
      activeRunId: row?.activeRunId ?? null,
      blockedReason: row?.blockedReason ?? null,
      lastTransitionTo: lastTransition?.to ?? null,
    };
  };

  test('AC1 — stop_run on a story with an active implement run: BLOCKED(interrupted), session interrupted, run aborted as interrupted, no attempt consumed, job cancelled', async () => {
    const registry = new RunInterruptRegistry();
    let runSettled = false;
    const hook: (HookObservation & { runStillInFlight: boolean })[] = [];
    const bus = new EventBus();
    const workflow = new WorkflowService({
      db: t.db,
      bus,
      onRunInterrupt: (storyId, runId) => {
        hook.push({ ...observe(storyId, runId), runStillInFlight: !runSettled });
        return registry.requestStop(storyId);
      },
    });
    const stories = new StoryService({ db: t.db, workflow, bus });
    const queue = new JobQueue(t.db);

    // A real temp repo + worktree, as in the sibling integration tests (never a real repository).
    const repoPath = makeTempRepo({ name: 'run-interrupt' });
    const project = seedProject(t.db, { repoPath, baseBranch: 'main' });
    const worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-runint-wt-') });
    const story = seedStory(t.db, project.id, { key: 'INT-1', title: 'Interrupt me', status: 'READY', planningStatus: 'plan_approved' });
    seedPlan(t.db, story.id, { status: 'approved' });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: story.key, baseBranch: 'main' });

    // The runner would have leased the implement job driving this run.
    const { id: implementJobId } = queue.enqueue({ kind: 'implement', slot: 'heavy', storyId: story.id, sideEffecting: true, idempotencyKey: `implement_${story.id}_0` });
    const leased = queue.claim('heavy');
    expect(leased).toMatchObject({ id: implementJobId, kind: 'implement' });

    // Fake runtime shaped like the real one: it registers through onSessionCreated, then polls
    // shouldStop() like the real poll loop and aborts with a structured `interrupted` flag.
    const SESSION = 'ses_runint_1';
    let signalStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const interruptCalls: { sessionId: string; directory: string }[] = [];
    const runtime = {
      runOneShot: async (input: RunOneShotInput): Promise<RunOneShotOutput> => {
        await input.onSessionCreated?.(SESSION, undefined);
        signalStarted();
        if (!(await waitUntil(() => input.shouldStop?.() ?? false, 5_000))) {
          return { ok: false, error: 'test patience elapsed without a stop request' };
        }
        return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
      },
      interrupt: async (sessionId: string, directory: string) => {
        interruptCalls.push({ sessionId, directory });
        return true;
      },
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({ db: t.db, workflow, bus, runtime, worktreeManager, interrupts: registry });
    const runPromise = agent.implementStory({ storyId: story.id });
    void runPromise.then(() => { runSettled = true; }, () => { runSettled = true; });
    await runStarted;

    // Mid-flight: the claim transition happened and the session handle is registered.
    const midRun = getStoryRow(t.db, story.id);
    const activeRunId = midRun?.activeRunId ?? null;
    expect(midRun?.status).toBe('IN_PROGRESS');
    expect(activeRunId).toBeTypeOf('number');
    expect(registry.active(story.id)?.runId).toBe(activeRunId);
    expect(t.db.select().from(agentRuns).where(eq(agentRuns.id, activeRunId!)).get()).toMatchObject({ status: 'running', opencodeSessionId: SESSION });

    // A human stops the run through the real human path (expectedVersion is 1 after the claim).
    const dto = stories.transition(story.id, { event: 'stop_run', expectedVersion: 1 });

    expect(dto.status).toBe('BLOCKED');
    expect(dto.blocked).toMatchObject({ reason: 'interrupted', from: 'IN_PROGRESS' });
    expect(dto.activeRun).toBeNull();

    // The run aborts without side effects on the worktree.
    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' })).toBe('');

    // The hook fired exactly once, after commit (committed state visible), while the run was in flight.
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({
      storyId: story.id,
      runId: activeRunId,
      storyStatus: 'BLOCKED',
      storyVersion: 2,
      activeRunId: null,
      blockedReason: 'interrupted',
      lastTransitionTo: 'BLOCKED',
      runStillInFlight: true,
    });

    // The registry handle stopped the OpenCode session (§18.5 interrupt call)…
    expect(interruptCalls).toEqual([{ sessionId: SESSION, directory: worktreePath }]);
    // …and no handle or stop flag survives the run.
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);

    // agent_runs ends 'interrupted' (not 'failed'), no attempt was consumed, and the leased
    // implement job is gone from the live set (cancel_jobs).
    expect(t.db.select().from(agentRuns).where(eq(agentRuns.id, activeRunId!)).get()).toMatchObject({ status: 'interrupted', exitReason: 'Interrupted by a stop request' });
    expect(getStoryRow(t.db, story.id)).toMatchObject({ status: 'BLOCKED', blockedReason: 'interrupted', blockedFrom: 'IN_PROGRESS', attemptCount: 0, activeRunId: null, statusVersion: 2 });
    const jobRows = jobsForStory(story.id);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ id: implementJobId, status: 'cancelled', leaseToken: null, leaseExpiresAt: null });

    // The audit trail records the interrupt effect for exactly the run that was stopped.
    const stopEvent = t.db.select().from(storyEvents).where(eq(storyEvents.storyId, story.id)).all().find((e) => e.toStatus === 'BLOCKED');
    expect((stopEvent?.payload as { effects?: unknown[] } | null)?.effects).toEqual([{ kind: 'interrupt_active_run', runId: activeRunId }, { kind: 'cancel_jobs' }]);
  });

  test('AC2 — cancel while a job is leased: queued and leased rows become cancelled with a cleared lease, the stop handle fires, and discovery does not re-enqueue', async () => {
    const registry = new RunInterruptRegistry();
    const hook: HookObservation[] = [];
    const bus = new EventBus();
    const workflow = new WorkflowService({
      db: t.db,
      bus,
      onRunInterrupt: (storyId, runId) => {
        hook.push(observe(storyId, runId));
        return registry.requestStop(storyId);
      },
    });
    const stories = new StoryService({ db: t.db, workflow, bus });
    const queue = new JobQueue(t.db);

    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, { key: 'INT-2', title: 'Cancel me', status: 'TESTING' });
    const runId = seedActiveRun(story.id);
    forceStory(t.db, story.id, { activeRunId: runId });
    const stop = vi.fn(async () => {});
    registry.register(story.id, { runId, stop });

    // One leased job (an in-flight repair, held by a "worker") and one still queued.
    const { id: leasedId } = queue.enqueue({ kind: 'implement', slot: 'heavy', storyId: story.id, sideEffecting: true, idempotencyKey: `rework_${story.id}_0` });
    const leased = queue.claim('heavy');
    expect(leased?.id).toBe(leasedId);
    const { id: queuedId } = queue.enqueue({ kind: 'verify', slot: 'heavy', storyId: story.id, sideEffecting: false, idempotencyKey: `verify_${story.id}_aa` });

    const dto = stories.transition(story.id, { event: 'cancel', expectedVersion: 0 });

    expect(dto.status).toBe('CANCELLED');
    expect(dto.activeRun).toBeNull();
    expect(getStoryRow(t.db, story.id)?.cancelledAt).toBeInstanceOf(Date);

    // Durable rows: queued AND leased become 'cancelled' with the lease released (T13/T17).
    const rows = jobsForStory(story.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null });

    // The still-running worker's completion can no longer land — a silent no-op by design (I9),
    // which is why follow-up enqueues are gated on complete()'s return elsewhere.
    expect(queue.complete(leased!.id, leased!.leaseToken)).toBe(false);

    // The run was stopped too: the hook fired once with the active run and the handle's stop ran.
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ storyId: story.id, runId, storyStatus: 'CANCELLED', storyVersion: 1, activeRunId: null, lastTransitionTo: 'CANCELLED' });
    expect(stop).toHaveBeenCalledTimes(1);

    // Discovery does not re-enqueue anything for the cancelled story (cancelledAt guard).
    const planner = { planStory: vi.fn() };
    const implementer = { implementStory: vi.fn() };
    const verification = { verifyStory: vi.fn() };
    const reviewer = { reviewStory: vi.fn() };
    const runner = new AgentRunner({
      db: t.db,
      queue,
      workflow,
      bus,
      planner: planner as unknown as PlannerAgent,
      implementer: implementer as unknown as ImplementerAgent,
      verification: verification as unknown as VerificationRunner,
      reviewer: reviewer as unknown as ReviewerAgent,
    });
    await runner.tick();

    expect(planner.planStory).not.toHaveBeenCalled();
    expect(implementer.implementStory).not.toHaveBeenCalled();
    expect(verification.verifyStory).not.toHaveBeenCalled();
    expect(reviewer.reviewStory).not.toHaveBeenCalled();
    const after = jobsForStory(story.id);
    expect(after.map((j) => j.id).sort()).toEqual([leasedId, queuedId].sort());
    expect(after.filter((j) => j.status === 'queued' || j.status === 'leased')).toHaveLength(0);
  });

  test('AC3a — the human path (StoryService.transition stop_run) fires the hook once post-commit; a guard-refused retry fires nothing', () => {
    const registry = new RunInterruptRegistry();
    const hook: HookObservation[] = [];
    const bus = new EventBus();
    const workflow = new WorkflowService({
      db: t.db,
      bus,
      onRunInterrupt: (storyId, runId) => {
        hook.push(observe(storyId, runId));
        return registry.requestStop(storyId);
      },
    });
    const stories = new StoryService({ db: t.db, workflow, bus });

    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, { key: 'INT-3', title: 'Human stop' });
    const runId = seedActiveRun(story.id);
    forceStory(t.db, story.id, { status: 'IN_PROGRESS', activeRunId: runId });

    const dto = stories.transition(story.id, { event: 'stop_run', expectedVersion: 0 });

    expect(dto.status).toBe('BLOCKED');
    expect(dto.blocked).toMatchObject({ reason: 'interrupted', from: 'IN_PROGRESS' });
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ storyId: story.id, runId, storyStatus: 'BLOCKED', storyVersion: 1, activeRunId: null, blockedReason: 'interrupted', lastTransitionTo: 'BLOCKED' });

    // A second stop_run against the now-BLOCKED story is guard-refused and never fires the hook.
    expect(() => stories.transition(story.id, { event: 'stop_run', expectedVersion: dto.statusVersion })).toThrow(ApiHttpError);
    expect(hook).toHaveLength(1);
  });

  test('AC3b — the system path (WorkflowService.transition fail) fires the same hook post-commit with the effect runId', () => {
    const registry = new RunInterruptRegistry();
    const hook: HookObservation[] = [];
    const bus = new EventBus();
    const workflow = new WorkflowService({
      db: t.db,
      bus,
      onRunInterrupt: (storyId, runId) => {
        hook.push(observe(storyId, runId));
        return registry.requestStop(storyId);
      },
    });

    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, { key: 'INT-4', title: 'System fail' });
    const runId = seedActiveRun(story.id);
    forceStory(t.db, story.id, { status: 'IN_PROGRESS', activeRunId: runId });

    const outcome = workflow.transition({
      storyId: story.id,
      event: { type: 'fail', reason: 'interrupted', detail: 'Server restarted while a run was active' },
      actor: 'system',
    });

    expect(outcome).toMatchObject({ ok: true, story: { status: 'BLOCKED', blockedReason: 'interrupted', statusVersion: 1 } });
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ storyId: story.id, runId, storyStatus: 'BLOCKED', storyVersion: 1, activeRunId: null, lastTransitionTo: 'BLOCKED' });
  });

  test('D1 — stop_run during a verify job (TESTING, no active run) still reaches the check kill handle via the story-scoped interrupt', async () => {
    const registry = new RunInterruptRegistry();
    const hook: HookObservation[] = [];
    const bus = new EventBus();
    const workflow = new WorkflowService({
      db: t.db,
      bus,
      onRunInterrupt: (storyId, runId) => {
        hook.push(observe(storyId, runId));
        return registry.requestStop(storyId);
      },
    });
    const stories = new StoryService({ db: t.db, workflow, bus });
    const queue = new JobQueue(t.db);

    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, { key: 'INT-5', title: 'Stop my checks', status: 'TESTING' });

    // Verification checks run with activeRunId = null, so the machine emits no
    // interrupt_active_run — only cancel_jobs. The kill handle registered by the
    // VerificationRunner has no runId (QA defect D1 regression guard).
    expect(getStoryRow(t.db, story.id)?.activeRunId).toBeNull();
    const kill = vi.fn(async () => {});
    registry.register(story.id, { stop: kill });

    const { id: verifyJobId } = queue.enqueue({ kind: 'verify', slot: 'heavy', storyId: story.id, sideEffecting: false, idempotencyKey: `verify_${story.id}_bb` });
    const leased = queue.claim('heavy');
    expect(leased?.id).toBe(verifyJobId);

    const dto = stories.transition(story.id, { event: 'stop_run', expectedVersion: 0 });

    expect(dto.status).toBe('BLOCKED');
    expect(dto.blocked).toMatchObject({ reason: 'interrupted', from: 'TESTING' });

    // Story-scoped interrupt: exactly one hook firing, without a runId.
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ storyId: story.id, storyStatus: 'BLOCKED', storyVersion: 1, activeRunId: null, blockedReason: 'interrupted', lastTransitionTo: 'BLOCKED' });
    expect(hook[0]?.runId).toBeUndefined();

    // The check kill handle was reached and the verify job was cancelled with its lease released.
    expect(kill).toHaveBeenCalledTimes(1);
    const jobRows = jobsForStory(story.id);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ id: verifyJobId, status: 'cancelled', leaseToken: null, leaseExpiresAt: null });
  });
});

describe('stop-flag fail-safe (EXE-13 sanity)', () => {
  test('the registry stop flag alone aborts a fake run whose shouldStop polls it — no registered handle needed', async () => {
    const registry = new RunInterruptRegistry();
    let signalStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => { signalStarted = resolve; });

    // A fake run shaped like the runtime's poll loop: it only ever consults shouldStop().
    const runPromise = (async (): Promise<RunOneShotOutput> => {
      signalStarted();
      const shouldStop = () => registry.isStopRequested(4242);
      if (!(await waitUntil(shouldStop, 2_000))) return { ok: false, error: 'test patience elapsed without a stop request' };
      return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
    })();

    await runStarted;
    await registry.requestStop(4242); // no handle registered → only the flag is set

    await expect(runPromise).resolves.toMatchObject({ ok: false, interrupted: true });
    expect(registry.isStopRequested(4242)).toBe(true); // the flag persists until unregister
  });

  test('a stale stop flag never poisons the next run: register clears it (boot-sweep shape, QA defect B)', async () => {
    const registry = new RunInterruptRegistry();
    // Crash-mid-run boot sweep: fail(interrupted) fires with no run registered — only the flag lands.
    await registry.requestStop(77);
    expect(registry.isStopRequested(77)).toBe(true);
    // After recover, the next run registers and must not inherit the stale flag.
    const stop = vi.fn(async () => {});
    registry.register(77, { runId: 9, stop });
    expect(registry.isStopRequested(77)).toBe(false);
    // A genuine later stop still works on the new handle.
    await registry.requestStop(77);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.isStopRequested(77)).toBe(true);
  });
});
