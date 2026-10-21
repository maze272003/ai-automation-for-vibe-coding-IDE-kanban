import { durableJobs } from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/queue.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

let t: ReturnType<typeof createTestDb>;
let now: number;
let q: JobQueue;
let storyId: number;

beforeEach(() => {
  t = createTestDb();
  now = 1_000_000;
  let n = 0;
  q = new JobQueue(t.db, { now: () => now, leaseMs: 60_000, newToken: () => `tok-${++n}` });
  storyId = seedStory(t.db, seedProject(t.db).id).id;
  return () => t.close();
});

const job = (key: string, extra: Partial<Parameters<JobQueue['enqueue']>[0]> = {}) =>
  q.enqueue({ kind: 'implement', slot: 'heavy', storyId, sideEffecting: true, idempotencyKey: key, ...extra });
const statusOf = (id: number) => t.db.select().from(durableJobs).where(eq(durableJobs.id, id)).get()?.status;

describe('JobQueue', () => {
  it('ignores duplicate enqueues with the same idempotency key', () => {
    const a = job('story:1:implement:1');
    const b = job('story:1:implement:1');
    expect(a).toEqual({ id: a.id, created: true });
    expect(b).toEqual({ id: a.id, created: false });
  });

  it('leases one job per lane, so different repositories run in parallel', () => {
    // The heavy lane is narrowed per repository (spec ADV-1): one job at a time per lane, while
    // different lanes are independent of each other.
    job('h1', { slot: 'heavy:repo:aaa' });
    job('h2', { slot: 'heavy:repo:bbb' });
    job('h3', { slot: 'heavy:repo:aaa' });

    const first = q.claim('heavy:repo:aaa');
    expect(first?.leaseToken).toBe('tok-1');
    // The same lane stays serialized…
    expect(q.claim('heavy:repo:aaa')).toBeNull();
    // …while another repository is free to work in parallel.
    const other = q.claim('heavy:repo:bbb');
    expect(other?.leaseToken).toBe('tok-2');
    expect(q.claim('heavy:repo:bbb')).toBeNull();
  });

  it('never leases two heavy jobs at once, but light jobs are independent', () => {    job('h1');
    job('h2');
    q.enqueue({ kind: 'pr_poll', slot: 'light', sideEffecting: false, idempotencyKey: 'l1' });
    const first = q.claim('heavy');
    expect(first?.leaseToken).toBe('tok-1');
    expect(q.claim('heavy')).toBeNull();
    expect(q.claim('light')?.kind).toBe('pr_poll');
  });

  it('respects runAfter', () => {
    job('later', { runAfter: now + 5_000 });
    expect(q.claim('heavy')).toBeNull();
    now += 5_000;
    expect(q.claim('heavy')).not.toBeNull();
  });

  it('heartbeat and completion require the current lease token', () => {
    const { id } = job('h1');
    const leased = q.claim('heavy')!;
    expect(q.heartbeat(id, 'wrong')).toBe(false);
    now += 50_000;
    expect(q.heartbeat(id, leased.leaseToken)).toBe(true);
    now += 50_000; // still within the extended lease
    expect(q.claim('heavy')).toBeNull();
    expect(q.complete(id, 'wrong')).toBe(false);
    expect(q.complete(id, leased.leaseToken)).toBe(true);
    expect(statusOf(id)).toBe('succeeded');
    expect(q.complete(id, leased.leaseToken)).toBe(false);
  });

  it('retries with backoff until maxAttempts, then dead-letters', () => {
    const { id } = job('h1', { maxAttempts: 2, sideEffecting: false });
    let l = q.claim('heavy')!;
    expect(q.fail(id, l.leaseToken, 'boom', { retry: true, retryDelayMs: 1_000 })).toBe('requeued');
    expect(q.claim('heavy')).toBeNull();
    now += 1_000;
    l = q.claim('heavy')!;
    expect(l.attempts).toBe(2);
    expect(q.fail(id, l.leaseToken, 'boom again', { retry: true })).toBe('dead');
    expect(statusOf(id)).toBe('dead');
  });

  it('marks non-retryable failures failed and rejects stale tokens', () => {
    const { id } = job('h1');
    const l = q.claim('heavy')!;
    expect(q.fail(id, 'stale', 'x')).toBe('stale');
    expect(q.fail(id, l.leaseToken, 'x')).toBe('failed');
  });

  it('sweeps expired leases: side-effecting → interrupted, idempotent → requeued or dead', () => {
    const se = job('se');
    const idem = q.enqueue({ kind: 'verify', slot: 'light', storyId, sideEffecting: false, idempotencyKey: 'idem' });
    const last = q.enqueue({ kind: 'fetch', slot: 'light', sideEffecting: false, idempotencyKey: 'last', maxAttempts: 1 });
    q.claim('heavy');
    q.claim('light');
    now += 61_000;
    q.claim('light'); // expired light lease no longer blocks: claims `last`
    now += 61_000;
    const swept = q.sweepExpired();
    expect(swept.interrupted).toEqual([{ jobId: se.id, kind: 'implement', storyId }]);
    expect(swept.requeued).toEqual([idem.id]);
    expect(swept.dead).toEqual([last.id]);
    expect(statusOf(se.id)).toBe('failed');
  });

  it('cancelForStory cancels queued and leased jobs; a cancelled lease cannot complete', () => {
    const a = job('a');
    job('b');
    const l = q.claim('heavy')!;
    expect(q.cancelForStory(storyId)).toBe(2);
    expect(q.complete(a.id, l.leaseToken)).toBe(false);
  });
});
