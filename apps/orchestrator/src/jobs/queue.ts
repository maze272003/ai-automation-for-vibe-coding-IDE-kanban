import { durableJobs, type AikDb, type JOB_KINDS, type JOB_SLOTS } from '@aik/db';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import crypto from 'node:crypto';
import { systemClock, type Clock } from '../time.ts';

export type JobKind = (typeof JOB_KINDS)[number];
export type JobSlot = (typeof JOB_SLOTS)[number];

export interface EnqueueInput {
  kind: JobKind;
  slot: JobSlot;
  storyId?: number | null;
  payload?: Record<string, unknown>;
  sideEffecting: boolean;
  idempotencyKey: string;
  runAfter?: number;
  maxAttempts?: number;
}

export interface LeasedJob {
  id: number;
  kind: JobKind;
  slot: JobSlot;
  storyId: number | null;
  payload: Record<string, unknown>;
  sideEffecting: boolean;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  leaseExpiresAt: number;
}

/** Durable at-least-once queue on SQLite with leases (spec §15, FND-7). One job per slot at a time. */
export class JobQueue {
  private readonly db: AikDb;
  private readonly now: Clock;
  private readonly leaseMs: number;
  private readonly newToken: () => string;

  constructor(db: AikDb, opts: { now?: Clock; leaseMs?: number; newToken?: () => string } = {}) {
    this.db = db;
    this.now = opts.now ?? systemClock;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.newToken = opts.newToken ?? (() => crypto.randomBytes(16).toString('hex'));
  }

  enqueue(input: EnqueueInput): { id: number; created: boolean } {
    const now = new Date(this.now());
    const inserted = this.db
      .insert(durableJobs)
      .values({
        kind: input.kind,
        slot: input.slot,
        storyId: input.storyId ?? null,
        payload: input.payload ?? {},
        sideEffecting: input.sideEffecting,
        status: 'queued',
        maxAttempts: input.maxAttempts ?? 3,
        runAfter: new Date(input.runAfter ?? this.now()),
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: durableJobs.idempotencyKey })
      .returning({ id: durableJobs.id })
      .get();
    if (inserted) return { id: inserted.id, created: true };
    const existing = this.db.select({ id: durableJobs.id }).from(durableJobs).where(eq(durableJobs.idempotencyKey, input.idempotencyKey)).get();
    if (!existing) throw new Error(`enqueue conflict without an existing row for ${input.idempotencyKey}`);
    return { id: existing.id, created: false };
  }

  claim(slot: JobSlot): LeasedJob | null {
    return this.db.transaction(
      (tx) => {
        const nowMs = this.now();
        const busy = tx
          .select({ id: durableJobs.id })
          .from(durableJobs)
          .where(and(eq(durableJobs.slot, slot), eq(durableJobs.status, 'leased'), gt(durableJobs.leaseExpiresAt, new Date(nowMs))))
          .get();
        if (busy) return null;
        const next = tx
          .select()
          .from(durableJobs)
          .where(and(eq(durableJobs.slot, slot), eq(durableJobs.status, 'queued'), lte(durableJobs.runAfter, new Date(nowMs))))
          .orderBy(asc(durableJobs.runAfter), asc(durableJobs.id))
          .limit(1)
          .get();
        if (!next) return null;
        const token = this.newToken();
        const row = tx
          .update(durableJobs)
          .set({
            status: 'leased',
            leaseToken: token,
            leaseExpiresAt: new Date(nowMs + this.leaseMs),
            heartbeatAt: new Date(nowMs),
            attempts: next.attempts + 1,
            updatedAt: new Date(nowMs),
          })
          .where(and(eq(durableJobs.id, next.id), eq(durableJobs.status, 'queued')))
          .returning()
          .get();
        if (!row) return null;
        return {
          id: row.id, kind: row.kind, slot: row.slot, storyId: row.storyId, payload: row.payload, sideEffecting: row.sideEffecting,
          attempts: row.attempts, maxAttempts: row.maxAttempts, leaseToken: token, leaseExpiresAt: nowMs + this.leaseMs,
        };
      },
      { behavior: 'immediate' },
    );
  }

  heartbeat(jobId: number, leaseToken: string): boolean {
    const nowMs = this.now();
    const r = this.db
      .update(durableJobs)
      .set({ leaseExpiresAt: new Date(nowMs + this.leaseMs), heartbeatAt: new Date(nowMs), updatedAt: new Date(nowMs) })
      .where(this.leaseMatches(jobId, leaseToken))
      .run();
    return r.changes === 1;
  }

  complete(jobId: number, leaseToken: string): boolean {
    const r = this.db
      .update(durableJobs)
      .set({ status: 'succeeded', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(this.now()) })
      .where(this.leaseMatches(jobId, leaseToken))
      .run();
    return r.changes === 1;
  }

  fail(jobId: number, leaseToken: string, error: string, opts: { retry?: boolean; retryDelayMs?: number } = {}): 'requeued' | 'failed' | 'dead' | 'stale' {
    return this.db.transaction(
      (tx) => {
        const job = tx.select().from(durableJobs).where(this.leaseMatches(jobId, leaseToken)).get();
        if (!job) return 'stale';
        const nowMs = this.now();
        const base = { leaseToken: null, leaseExpiresAt: null, lastError: error, updatedAt: new Date(nowMs) };
        if (opts.retry && job.attempts < job.maxAttempts) {
          tx.update(durableJobs).set({ ...base, status: 'queued', runAfter: new Date(nowMs + (opts.retryDelayMs ?? 0)) }).where(eq(durableJobs.id, jobId)).run();
          return 'requeued';
        }
        const status = opts.retry ? 'dead' : 'failed';
        tx.update(durableJobs).set({ ...base, status }).where(eq(durableJobs.id, jobId)).run();
        return status;
      },
      { behavior: 'immediate' },
    );
  }

  /** Recovery after a crash/restart (spec §6.10): never silently re-run side-effecting work. */
  sweepExpired(): { requeued: number[]; dead: number[]; interrupted: { jobId: number; kind: JobKind; storyId: number | null }[] } {
    return this.db.transaction(
      (tx) => {
        const nowMs = this.now();
        const expired = tx
          .select()
          .from(durableJobs)
          .where(and(eq(durableJobs.status, 'leased'), lte(durableJobs.leaseExpiresAt, new Date(nowMs))))
          .orderBy(asc(durableJobs.id))
          .all();
        const out = { requeued: [] as number[], dead: [] as number[], interrupted: [] as { jobId: number; kind: JobKind; storyId: number | null }[] };
        const clear = { leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(nowMs) };
        for (const j of expired) {
          if (j.sideEffecting) {
            tx.update(durableJobs).set({ ...clear, status: 'failed', lastError: 'interrupted: lease expired (orchestrator restart or crash)' }).where(eq(durableJobs.id, j.id)).run();
            out.interrupted.push({ jobId: j.id, kind: j.kind, storyId: j.storyId });
          } else if (j.attempts < j.maxAttempts) {
            tx.update(durableJobs).set({ ...clear, status: 'queued', runAfter: new Date(nowMs) }).where(eq(durableJobs.id, j.id)).run();
            out.requeued.push(j.id);
          } else {
            tx.update(durableJobs).set({ ...clear, status: 'dead', lastError: 'lease expired at max attempts' }).where(eq(durableJobs.id, j.id)).run();
            out.dead.push(j.id);
          }
        }
        return out;
      },
      { behavior: 'immediate' },
    );
  }

  cancelForStory(storyId: number): number {
    const r = this.db
      .update(durableJobs)
      .set({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(this.now()) })
      .where(and(eq(durableJobs.storyId, storyId), inArray(durableJobs.status, ['queued', 'leased'])))
      .run();
    return r.changes;
  }

  private leaseMatches(jobId: number, leaseToken: string) {
    return and(eq(durableJobs.id, jobId), eq(durableJobs.leaseToken, leaseToken), eq(durableJobs.status, 'leased'));
  }
}
