// apps/orchestrator/src/agents/planning-budget.ts
// B7: the planning retry budget is scoped to a planning round. A human `edit_definition`, or a
// `recover` that returns the story to NEW, starts a fresh round — planner failures from a round
// the human already intervened in must not keep consuming the story's budget.
import { agentRuns, storyEvents, type AikDbOrTx } from '@aik/db';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';

/** How many planner runs may fail per planning round before the story is left for a human (B7). */
export const MAX_PLANNING_ATTEMPTS = 3;

/**
 * The newest human reset of a story's planning round: an `edit_definition` transition, or a
 * `recover` transition whose target is NEW. Planner failures before it no longer count.
 */
export function lastPlanningReset(db: AikDbOrTx, storyId: number): { eventId: number; at: Date } | null {
  const row = db
    .select({ eventId: storyEvents.id, at: storyEvents.createdAt })
    .from(storyEvents)
    .where(and(
      eq(storyEvents.storyId, storyId),
      eq(storyEvents.type, 'transition'),
      or(
        sql`json_extract(${storyEvents.payload}, '$.event.type') = 'edit_definition'`,
        and(
          sql`json_extract(${storyEvents.payload}, '$.event.type') = 'recover'`,
          sql`json_extract(${storyEvents.payload}, '$.event.target') = 'NEW'`,
        ),
      ),
    ))
    .orderBy(desc(storyEvents.id))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Failed or timed-out planner runs started after the last planning reset — all of them when the
 * story has no reset. `timed_out` counts because it is a planner run's timeout failure status.
 */
export function failedPlannerRunsSinceReset(db: AikDbOrTx, storyId: number): number {
  const reset = lastPlanningReset(db, storyId);
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.storyId, storyId),
      eq(agentRuns.role, 'planner'),
      inArray(agentRuns.status, ['failed', 'timed_out']),
      ...(reset ? [gt(agentRuns.startedAt, reset.at)] : []),
    ))
    .all().length;
}
