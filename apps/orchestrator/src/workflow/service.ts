import type { FailedGuard, Role } from '@aik/contracts';
import { durableJobs, plans, storyEvents, userStories, type AikDb, type AikTx } from '@aik/db';
import { evaluate, provenanceFor, type Effect, type TransitionId, type WorkflowEvent } from '@aik/workflow';
import { and, eq, inArray } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import { systemClock, type Clock } from '../time.ts';
import { getStoryRow, loadSnapshot, type StoryRow } from './snapshot.ts';

export type Actor = 'human' | 'system' | `agent:${Role}`;

export interface TransitionInput {
  storyId: number;
  event: WorkflowEvent;
  /** Required for human requests; system callers may omit it to act on the current version. */
  expectedVersion?: number;
  actor: Actor;
  idempotencyKey?: string;
}

export type TransitionOutcome =
  | { ok: true; duplicate: boolean; transitionId: TransitionId | null; story: StoryRow }
  | { ok: false; code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'GUARD_FAILED'; failedGuards?: FailedGuard[] };

export interface WorkflowServiceDeps {
  db: AikDb;
  bus: EventBus;
  now?: Clock;
  redact?: (text: string) => string;
  /** Test hook: runs inside the transaction just before commit. */
  beforeCommit?: () => void;
}

/** The single authority over story status (spec §16). */
export class WorkflowService {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly beforeCommit?: () => void;

  constructor(deps: WorkflowServiceDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.beforeCommit = deps.beforeCommit;
  }

  transition(input: TransitionInput): TransitionOutcome {
    const { outcome, notifySeq } = this.db.transaction((tx) => this.transitionIn(tx, input), { behavior: 'immediate' });
    if (notifySeq !== null) this.bus.notify(notifySeq);
    return outcome;
  }

  /** Runs inside a caller-owned transaction. The caller must call `bus.notify(notifySeq)` after commit. */
  transitionIn(tx: AikTx, input: TransitionInput): { outcome: TransitionOutcome; notifySeq: number | null } {
    if (input.idempotencyKey) {
      const dup = tx.select({ id: storyEvents.id }).from(storyEvents).where(eq(storyEvents.idempotencyKey, input.idempotencyKey)).get();
      if (dup) {
        const story = getStoryRow(tx, input.storyId);
        return story
          ? { outcome: { ok: true, duplicate: true, transitionId: null, story }, notifySeq: null }
          : { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null };
      }
    }

    const snap = loadSnapshot(tx, input.storyId);
    if (!snap) return { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null };
    if (input.expectedVersion !== undefined && input.expectedVersion !== snap.row.statusVersion) {
      return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null };
    }

    const event: WorkflowEvent = input.event.type === 'fail' ? { ...input.event, detail: this.redact(input.event.detail) } : input.event;
    const result = evaluate(snap.story, snap.evidence, event);
    if (!result.ok) return { outcome: { ok: false, code: 'GUARD_FAILED', failedGuards: result.failedGuards }, notifySeq: null };

    const now = new Date(this.now());
    const updated = tx
      .update(userStories)
      .set({
        ...result.patch, // StoryPatch keys mirror userStories columns; Drizzle ignores undefined values in set()
        statusVersion: snap.row.statusVersion + 1,
        updatedAt: now,
        ...(result.to === 'DONE' && result.from !== 'DONE' ? { doneAt: now } : {}),
        ...(result.to === 'CANCELLED' ? { cancelledAt: now } : {}),
      })
      .where(and(eq(userStories.id, input.storyId), eq(userStories.statusVersion, snap.row.statusVersion)))
      .returning()
      .get();
    if (!updated) return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null };

    applyEffects(tx, input.storyId, result.effects, now);
    tx.insert(storyEvents)
      .values({
        storyId: input.storyId,
        type: 'transition',
        fromStatus: result.from,
        toStatus: result.to,
        actor: input.actor,
        payload: { transition: result.id, event, effects: result.effects },
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
      })
      .run();
    const notifySeq = appendOutbox(
      tx,
      {
        topic: 'story.transitioned',
        storyId: input.storyId,
        provenance: provenanceFor(event.type, result.to),
        data: { key: updated.key, from: result.from, to: result.to, transition: result.id, statusVersion: updated.statusVersion },
      },
      now,
    );
    this.beforeCommit?.();
    return { outcome: { ok: true, duplicate: false, transitionId: result.id, story: updated }, notifySeq };
  }
}

function applyEffects(tx: AikTx, storyId: number, effects: Effect[], now: Date): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'approve_plan':
        tx.update(plans)
          .set({ status: 'approved', approvedBy: effect.by, approvedAt: now })
          .where(and(eq(plans.storyId, storyId), eq(plans.version, effect.planVersion)))
          .run();
        break;
      case 'supersede_plan':
        tx.update(plans)
          .set({ status: 'superseded' })
          .where(and(eq(plans.storyId, storyId), inArray(plans.status, ['proposed', 'approved'])))
          .run();
        break;
      case 'cancel_jobs':
        tx.update(durableJobs)
          .set({ status: 'cancelled', updatedAt: now })
          .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.status, 'queued')))
          .run();
        break;
      case 'interrupt_active_run':
        // Executed by the agent runtime (Phase 2). It is recorded in the story event payload for audit.
        break;
    }
  }
}
