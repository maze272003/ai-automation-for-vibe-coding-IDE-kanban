import { agentRuns, clarifications, durableJobs, outboxEvents, plans, storyEvents } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { createRedactor } from '../src/secrets/redactor.ts';
import { getStoryRow } from '../src/workflow/snapshot.ts';
import { applyEffects, WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedPlan, seedProject, seedStory } from './helpers/db.ts';

let t: ReturnType<typeof createTestDb>;
let bus: EventBus;
let notified: number[];
let storyId: number;
const redactor = createRedactor();
redactor.addSecret('abcdefgh-secret');

function service(beforeCommit?: () => void, onRunInterrupt?: (storyId: number, runId?: number) => Promise<void> | void) {
  return new WorkflowService({ db: t.db, bus, now: () => 1_000, redact: redactor.redact, beforeCommit, onRunInterrupt });
}

beforeEach(() => {
  t = createTestDb();
  bus = new EventBus();
  notified = [];
  bus.subscribe((s) => notified.push(s));
  const p = seedProject(t.db);
  const s = seedStory(t.db, p.id, { planningStatus: 'plan_proposed' });
  seedAcceptanceCriterion(t.db, s.id);
  seedPlan(t.db, s.id);
  storyId = s.id;
  return () => t.close();
});

const approve = { type: 'approve_plan', planVersion: 1 } as const;
const counts = () => ({
  events: t.db.select().from(storyEvents).all().length,
  outbox: t.db.select().from(outboxEvents).all().length,
});

describe('WorkflowService.transition', () => {
  it('applies a valid transition atomically with audit, outbox, effects and notification', () => {
    const r = service().transition({ storyId, event: approve, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, duplicate: false, transitionId: 'T1', story: { status: 'READY', statusVersion: 1, planningStatus: 'plan_approved' } });
    const [ev] = t.db.select().from(storyEvents).all();
    expect(ev).toMatchObject({ storyId, type: 'transition', fromStatus: 'NEW', toStatus: 'READY', actor: 'human' });
    const [ob] = t.db.select().from(outboxEvents).all();
    expect(ob?.topic).toBe('story.transitioned');
    expect(ob?.payload.provenance).toBe('human_approval');
    expect(t.db.select().from(plans).get()).toMatchObject({ status: 'approved', approvedBy: 'human' });
    expect(notified).toEqual([ob?.seq]);
  });

  it('rejects a stale expectedVersion without writing anything', () => {
    expect(service().transition({ storyId, event: approve, expectedVersion: 3, actor: 'human' })).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect(counts()).toEqual({ events: 0, outbox: 0 });
  });

  it('lets only one of two writers with the same expectedVersion win', () => {
    const wf = service();
    expect(wf.transition({ storyId, event: { type: 'hold' }, expectedVersion: 0, actor: 'human' }).ok).toBe(true);
    expect(wf.transition({ storyId, event: { type: 'unhold' }, expectedVersion: 0, actor: 'human' })).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it('returns failed guards and writes nothing when guards fail', () => {
    const r = service().transition({ storyId, event: { type: 'approve_plan', planVersion: 2 }, expectedVersion: 0, actor: 'human' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedGuards?.map((g) => g.guard)).toEqual(['plan_version']);
    expect(counts()).toEqual({ events: 0, outbox: 0 });
  });

  it('treats a repeated idempotency key as a no-op duplicate', () => {
    const wf = service();
    expect(wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human', idempotencyKey: 'k-1' })).toMatchObject({ ok: true, duplicate: false });
    expect(wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human', idempotencyKey: 'k-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(counts().events).toBe(1);
  });

  it('rolls back status, audit, outbox and effects when the commit fails', () => {
    const wf = service(() => {
      throw new Error('injected failure');
    });
    expect(() => wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human' })).toThrow('injected failure');
    expect(getStoryRow(t.db, storyId)).toMatchObject({ status: 'NEW', statusVersion: 0 });
    expect(counts()).toEqual({ events: 0, outbox: 0 });
    expect(t.db.select().from(plans).get()?.status).toBe('proposed');
    expect(notified).toEqual([]);
  });

  it('cancel sets cancelledAt and cancels the story’s queued jobs', () => {
    const now = new Date();
    t.db.insert(durableJobs).values({ kind: 'plan', slot: 'heavy', storyId, payload: {}, sideEffecting: true, status: 'queued', runAfter: now, idempotencyKey: 'j1', createdAt: now, updatedAt: now }).run();
    const r = service().transition({ storyId, event: { type: 'cancel' }, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, story: { status: 'CANCELLED' } });
    if (r.ok) expect(r.story.cancelledAt).toBeInstanceOf(Date);
    expect(t.db.select().from(durableJobs).where(eq(durableJobs.storyId, storyId)).get()?.status).toBe('cancelled');
  });

  it('redacts secrets in blocked details', () => {
    forceStory(t.db, storyId, { status: 'IN_PROGRESS' });
    const r = service().transition({ storyId, event: { type: 'fail', reason: 'provider_down', detail: 'token abcdefgh-secret leaked' }, actor: 'system' });
    expect(r).toMatchObject({ ok: true, story: { status: 'BLOCKED', blockedReason: 'provider_down', blockedDetail: 'token [REDACTED:secret] leaked' } });
    expect(JSON.stringify(t.db.select().from(storyEvents).all())).not.toContain('abcdefgh-secret');
  });

  it('reports NOT_FOUND for an unknown story', () => {
    expect(service().transition({ storyId: 9999, event: { type: 'cancel' }, actor: 'human' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('run interruption effects (EXE-13, T13/T17)', () => {
  let runCounter = 0;
  /** Seeds a running agent run, makes it the story's active run, and returns its id. */
  const seedActiveRun = () => {
    runCounter += 1;
    const run = t.db
      .insert(agentRuns)
      .values({ storyId, role: 'implementer', attempt: 1, promptVersion: '1.0', opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `ir-${runCounter}`, startedAt: new Date() })
      .returning()
      .get();
    forceStory(t.db, storyId, { status: 'IN_PROGRESS', activeRunId: run.id });
    return run.id;
  };

  it('stop_run returns the active run as an interrupt and fires the hook after commit', () => {
    const runId = seedActiveRun();
    const order: string[] = [];
    const seen: string[] = [];
    const calls: { storyId: number; runId?: number }[] = [];
    const wf = service(
      () => order.push('beforeCommit'),
      (sid, rid) => {
        order.push('interrupt');
        calls.push({ storyId: sid, runId: rid });
        const row = getStoryRow(t.db, sid); // the hook must observe committed state
        seen.push(`${row?.status}@${row?.statusVersion}:${row?.activeRunId}`);
      },
    );
    const r = wf.transition({ storyId, event: { type: 'stop_run' }, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, story: { status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null } });
    expect(calls).toEqual([{ storyId, runId }]);
    expect(order).toEqual(['beforeCommit', 'interrupt']);
    expect(seen).toEqual(['BLOCKED@1:null']);
  });

  it('cancel also returns the active run as an interrupt (T17)', () => {
    const runId = seedActiveRun();
    const calls: (number | undefined)[] = [];
    const wf = service(undefined, (_sid, rid) => {
      calls.push(rid);
    });
    const r = wf.transition({ storyId, event: { type: 'cancel' }, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, story: { status: 'CANCELLED', activeRunId: null } });
    expect(calls).toEqual([runId]);
  });

  it('cancel_jobs cancels leased jobs too and releases their lease', () => {
    const now = new Date();
    t.db.insert(durableJobs).values([
      { kind: 'plan', slot: 'heavy', storyId, payload: {}, sideEffecting: false, status: 'queued', runAfter: now, idempotencyKey: 'queued-1', createdAt: now, updatedAt: now },
      { kind: 'implement', slot: 'heavy', storyId, payload: {}, sideEffecting: true, status: 'leased', runAfter: now, leaseToken: 'tok-1', leaseExpiresAt: now, heartbeatAt: now, idempotencyKey: 'leased-1', createdAt: now, updatedAt: now },
    ]).run();
    const r = service().transition({ storyId, event: { type: 'cancel' }, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, story: { status: 'CANCELLED' } });
    const rows = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, storyId)).all();
    expect(rows.map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
    expect(rows.find((j) => j.idempotencyKey === 'leased-1')).toMatchObject({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null });
  });

  it('a hook error never fails the transition (best-effort)', () => {
    seedActiveRun();
    const wf = service(undefined, () => {
      throw new Error('interrupt transport down');
    });
    expect(wf.transition({ storyId, event: { type: 'stop_run' }, expectedVersion: 0, actor: 'human' })).toMatchObject({ ok: true, story: { status: 'BLOCKED' } });
  });

  it('an async hook rejection is fire-and-forget and never fails the transition', async () => {
    seedActiveRun();
    const wf = service(undefined, () => Promise.reject(new Error('session wedged')));
    expect(wf.transition({ storyId, event: { type: 'stop_run' }, expectedVersion: 0, actor: 'human' })).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0)); // the rejection is already handled; nothing may surface now
  });

  it('a failed commit fires no interrupt hook', () => {
    const runId = seedActiveRun();
    const calls: (number | undefined)[] = [];
    const wf = service(
      () => {
        throw new Error('injected failure');
      },
      (_sid, rid) => {
        calls.push(rid);
      },
    );
    expect(() => wf.transition({ storyId, event: { type: 'stop_run' }, expectedVersion: 0, actor: 'human' })).toThrow('injected failure');
    expect(calls).toEqual([]);
    expect(getStoryRow(t.db, storyId)).toMatchObject({ status: 'IN_PROGRESS', statusVersion: 0, activeRunId: runId });
  });

  it('fail(interrupted) with no active run fires a harmless story-scoped interrupt (startup sweep, QA D1/B)', () => {
    forceStory(t.db, storyId, { status: 'IN_PROGRESS', activeRunId: null });
    const calls: (number | undefined)[] = [];
    const wf = service(undefined, (_sid, rid) => {
      calls.push(rid);
    });
    const r = wf.transition({ storyId, event: { type: 'fail', reason: 'interrupted', detail: 'Server restarted while a run was active' }, actor: 'system' });
    expect(r).toMatchObject({ ok: true, story: { status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null } });
    // cancel_jobs with no active run still yields one story-scoped interrupt (runId undefined)
    // so a stop can reach a running check tree. At boot the registry is empty, so this only
    // sets a flag that the next registered run clears (register() never inherits a stale flag).
    expect(calls).toEqual([undefined]);
  });

  it('transitionIn returns interrupts without executing them; the caller emits after commit', () => {
    const runId = seedActiveRun();
    const calls: (number | undefined)[] = [];
    const wf = service(undefined, (_sid, rid) => {
      calls.push(rid);
    });
    const { interrupts } = t.db.transaction((tx) => wf.transitionIn(tx, { storyId, event: { type: 'stop_run' }, expectedVersion: 0, actor: 'human' }), { behavior: 'immediate' });
    expect(interrupts).toEqual([{ storyId, runId }]);
    expect(calls).toEqual([]); // never fired inside the transaction
    wf.emitInterrupts(interrupts);
    expect(calls).toEqual([runId]); // the caller fires once, after commit
  });
});

describe('applyEffects: plan feedback (EXE-7)', () => {
  /** The plan row seeded by beforeEach (version 1, proposed). */
  const planV1 = () => t.db.select().from(plans).where(eq(plans.version, 1)).get()!;

  it('reject_plan marks the plan rejected with the feedback persisted', () => {
    t.db.transaction((tx) => applyEffects(tx, storyId, [{ kind: 'reject_plan', planVersion: 1, feedback: 'Batch the inserts instead' }], new Date(1_000)), { behavior: 'immediate' });
    expect(planV1()).toMatchObject({ status: 'rejected', rejectionFeedback: 'Batch the inserts instead' });
  });

  it('reject_plan with an unknown plan version is a silent no-op (approve_plan tolerance)', () => {
    expect(() =>
      t.db.transaction((tx) => applyEffects(tx, storyId, [{ kind: 'reject_plan', planVersion: 99, feedback: 'Ghost plan' }], new Date(1_000)), { behavior: 'immediate' }),
    ).not.toThrow();
    expect(planV1()).toMatchObject({ status: 'proposed', rejectionFeedback: null });
  });

  it('answer_clarifications writes answer/answeredAt on the matching rows only', () => {
    const other = seedPlan(t.db, storyId, { version: 2 }); // isolation: another plan of the same story
    const plan = planV1();
    t.db.insert(clarifications).values([
      { planId: plan.id, ordinal: 1, question: 'Which database?' },
      { planId: plan.id, ordinal: 2, question: 'Is auth needed?' },
      { planId: other.id, ordinal: 1, question: 'Other plan question?' },
    ]).run();
    t.db.transaction(
      (tx) => applyEffects(tx, storyId, [{ kind: 'answer_clarifications', planVersion: 1, answers: [{ ordinal: 1, answer: 'SQLite' }] }], new Date(1_000)),
      { behavior: 'immediate' },
    );
    const row = (planId: number, ordinal: number) =>
      t.db.select().from(clarifications).where(and(eq(clarifications.planId, planId), eq(clarifications.ordinal, ordinal))).get()!;
    expect(row(plan.id, 1)).toMatchObject({ answer: 'SQLite' });
    expect(row(plan.id, 1).answeredAt).toBeInstanceOf(Date);
    expect(row(plan.id, 2)).toMatchObject({ answer: null, answeredAt: null }); // unanswered stays open
    expect(row(other.id, 1)).toMatchObject({ answer: null, answeredAt: null }); // version pins the plan
  });

  it('answer_clarifications with unknown ordinals or an unknown plan version is a silent no-op', () => {
    const plan = planV1();
    t.db.insert(clarifications).values([{ planId: plan.id, ordinal: 1, question: 'Q?' }]).run();
    expect(() =>
      t.db.transaction((tx) => applyEffects(tx, storyId, [{ kind: 'answer_clarifications', planVersion: 1, answers: [{ ordinal: 7, answer: 'Ghost answer' }] }], new Date(1_000)), { behavior: 'immediate' }),
    ).not.toThrow();
    expect(() =>
      t.db.transaction((tx) => applyEffects(tx, storyId, [{ kind: 'answer_clarifications', planVersion: 99, answers: [{ ordinal: 1, answer: 'Ghost plan' }] }], new Date(1_000)), { behavior: 'immediate' }),
    ).not.toThrow();
    const row = t.db.select().from(clarifications).where(eq(clarifications.planId, plan.id)).get()!;
    expect(row).toMatchObject({ ordinal: 1, answer: null, answeredAt: null });
  });
});
