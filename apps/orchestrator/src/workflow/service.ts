import type { FailedGuard, Role } from '@aik/contracts';
import { clarifications, durableJobs, plans, storyEvents, userStories, type AikDb, type AikTx } from '@aik/db';
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
  /**
   * Best-effort side effect fired AFTER commit (spec §16.3 T13/T17, EXE-13): stop the story's
   * active work. Emitted for each `interrupt_active_run` effect, plus one story-scoped entry
   * (no runId) when jobs are cancelled while no active run exists — verification checks run
   * with `activeRunId = null`, so `cancel_jobs` must still reach their kill handle (QA D1).
   * Never called inside a transaction — better-sqlite3 transactions are synchronous and
   * side-effect free.
   */
  onRunInterrupt?: (storyId: number, runId?: number) => Promise<void> | void;
}

/** An interrupt captured by `transitionIn`; fire it via `emitInterrupts` after commit. */
export interface PendingRunInterrupt {
  storyId: number;
  /** The agent run to interrupt; omitted for story-scoped stops (e.g. a running check tree). */
  runId?: number;
}

/** The single authority over story status (spec §16). */
export class WorkflowService {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly beforeCommit?: () => void;
  private readonly onRunInterrupt?: (storyId: number, runId?: number) => Promise<void> | void;

  constructor(deps: WorkflowServiceDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.beforeCommit = deps.beforeCommit;
    this.onRunInterrupt = deps.onRunInterrupt;
  }

  transition(input: TransitionInput): TransitionOutcome {
    const { outcome, notifySeq, interrupts } = this.db.transaction((tx) => this.transitionIn(tx, input), { behavior: 'immediate' });
    if (notifySeq !== null) this.bus.notify(notifySeq);
    if (interrupts.length > 0) this.emitInterrupts(interrupts);
    return outcome;
  }

  /**
   * Runs inside a caller-owned transaction. The caller must, after commit: call
   * `bus.notify(notifySeq)` and fire the returned `interrupts` via `emitInterrupts`
   * (side effects never run inside the synchronous better-sqlite3 transaction).
   */
  transitionIn(tx: AikTx, input: TransitionInput): { outcome: TransitionOutcome; notifySeq: number | null; interrupts: PendingRunInterrupt[] } {
    if (input.idempotencyKey) {
      const dup = tx.select({ id: storyEvents.id }).from(storyEvents).where(eq(storyEvents.idempotencyKey, input.idempotencyKey)).get();
      if (dup) {
        const story = getStoryRow(tx, input.storyId);
        return story
          ? { outcome: { ok: true, duplicate: true, transitionId: null, story }, notifySeq: null, interrupts: [] }
          : { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null, interrupts: [] };
      }
    }

    const snap = loadSnapshot(tx, input.storyId);
    if (!snap) return { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null, interrupts: [] };
    if (input.expectedVersion !== undefined && input.expectedVersion !== snap.row.statusVersion) {
      return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null, interrupts: [] };
    }

    const event: WorkflowEvent = input.event.type === 'fail' ? { ...input.event, detail: this.redact(input.event.detail) } : input.event;
    const result = evaluate(snap.story, snap.evidence, event);
    if (!result.ok) return { outcome: { ok: false, code: 'GUARD_FAILED', failedGuards: result.failedGuards }, notifySeq: null, interrupts: [] };

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
    if (!updated) return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null, interrupts: [] };

    applyEffects(tx, input.storyId, result.effects, now);
    // Collect (never execute) the interrupt side effects; the caller fires them after commit.
    // `cancel_jobs` also yields a story-scoped interrupt when there is no active run to
    // interrupt: verification check trees run with activeRunId = null and must be killed by
    // a stop/cancel (QA D1). Deduplicated per story when a run-scoped entry already exists.
    const interrupts: PendingRunInterrupt[] = [];
    let runScopedInterrupt = false;
    let cancelsJobs = false;
    for (const effect of result.effects) {
      if (effect.kind === 'interrupt_active_run') {
        interrupts.push({ storyId: input.storyId, runId: effect.runId });
        runScopedInterrupt = true;
      } else if (effect.kind === 'cancel_jobs') {
        cancelsJobs = true;
      }
    }
    if (cancelsJobs && !runScopedInterrupt) interrupts.push({ storyId: input.storyId });
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
    return { outcome: { ok: true, duplicate: false, transitionId: result.id, story: updated }, notifySeq, interrupts };
  }

  /**
   * Fires `onRunInterrupt` once per captured `interrupt_active_run` effect. Call it only
   * AFTER the transaction commits — both `transition()` and the human path in
   * StoryService.transition() (which commits via `transitionIn`, BA condition C1) use it.
   * Best-effort by design: the story has already transitioned and committed, so a hook
   * error must never surface as a transition failure; async hooks are fire-and-forget.
   * The stop flag alone still aborts the local poll loop when the hook cannot.
   */
  emitInterrupts(interrupts: readonly PendingRunInterrupt[]): void {
    if (!this.onRunInterrupt) return;
    for (const { storyId, runId } of interrupts) {
      try {
        Promise.resolve(this.onRunInterrupt(storyId, runId)).catch(() => {
          // Best-effort; see docblock.
        });
      } catch {
        // Best-effort; see docblock.
      }
    }
  }
}

/**
 * Persists a transition's effects. Exported for direct persistence tests: the guards that emit
 * plan-feedback effects live in the machine, and driving them through `transition` couples the
 * persistence assertions to state-machine coverage owned elsewhere.
 */
export function applyEffects(tx: AikTx, storyId: number, effects: Effect[], now: Date): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'approve_plan':
        tx.update(plans)
          .set({ status: 'approved', approvedBy: effect.by, approvedAt: now })
          .where(and(eq(plans.storyId, storyId), eq(plans.version, effect.planVersion)))
          .run();
        break;
      case 'reject_plan':
        // Same lookup as approve_plan (plan_ver_uq): an unknown version matches no row and is a
        // silent no-op — the machine already refused mismatched versions before emitting this.
        tx.update(plans)
          .set({ status: 'rejected', rejectionFeedback: effect.feedback })
          .where(and(eq(plans.storyId, storyId), eq(plans.version, effect.planVersion)))
          .run();
        break;
      case 'answer_clarifications': {
        const plan = tx
          .select({ id: plans.id })
          .from(plans)
          .where(and(eq(plans.storyId, storyId), eq(plans.version, effect.planVersion)))
          .get();
        if (!plan) break; // unknown plan version: nothing to answer (no-op, like approve_plan)
        for (const a of effect.answers) {
          // Unknown ordinals match no row (no-op): StoryService already validated the exact
          // open set before the transition; this is belt-and-braces, not an authority.
          tx.update(clarifications)
            .set({ answer: a.answer, answeredAt: now })
            .where(and(eq(clarifications.planId, plan.id), eq(clarifications.ordinal, a.ordinal)))
            .run();
        }
        break;
      }
      case 'supersede_plan':
        tx.update(plans)
          .set({ status: 'superseded' })
          .where(and(eq(plans.storyId, storyId), inArray(plans.status, ['proposed', 'approved'])))
          .run();
        break;
      case 'cancel_jobs':
        // T13/T17: cancel queued AND leased jobs for the story and release the lease in one
        // update. A running handler's complete() then no-ops on the status mismatch by design.
        tx.update(durableJobs)
          .set({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null, updatedAt: now })
          .where(and(eq(durableJobs.storyId, storyId), inArray(durableJobs.status, ['queued', 'leased'])))
          .run();
        break;
      case 'interrupt_active_run':
        // Recorded in the story event payload for audit; the runtime stop itself is a
        // post-commit side effect fired by the caller via `emitInterrupts`.
        break;
    }
  }
}
