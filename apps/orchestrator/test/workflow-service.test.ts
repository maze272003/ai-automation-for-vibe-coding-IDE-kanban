import { durableJobs, outboxEvents, plans, storyEvents } from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { createRedactor } from '../src/secrets/redactor.ts';
import { getStoryRow } from '../src/workflow/snapshot.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedPlan, seedProject, seedStory } from './helpers/db.ts';

let t: ReturnType<typeof createTestDb>;
let bus: EventBus;
let notified: number[];
let storyId: number;
const redactor = createRedactor();
redactor.addSecret('abcdefgh-secret');

function service(beforeCommit?: () => void) {
  return new WorkflowService({ db: t.db, bus, now: () => 1_000, redact: redactor.redact, beforeCommit });
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
