// apps/orchestrator/src/projects/purge-repo.ts
import { IMMUTABLE_TABLES, userStories, type AikDb } from '@aik/db';
import { eq, sql } from 'drizzle-orm';

/** The tx handle drizzle passes into transaction callbacks. */
type PurgeTx = Parameters<Parameters<AikDb['transaction']>[0]>[0];

/**
 * The sanctioned §15.3 purge: drop append-only delete triggers, run the ordered
 * deletes for every project- or story-scoped table in one immediate transaction,
 * recreate the triggers. Never called outside ProjectService.delete.
 */
export function purgeProjectData(db: AikDb, projectId: number): { stories: number } {
  return db.transaction((tx) => purgeIn(tx, projectId), { behavior: 'immediate' });
}

const IMMUTABLE = IMMUTABLE_TABLES;
const dropTriggers = (tx: PurgeTx) => {
  for (const t of IMMUTABLE) tx.run(sql.raw(`DROP TRIGGER IF EXISTS "${t}_no_delete"`));
};
const recreateTriggers = (tx: PurgeTx) => {
  for (const t of IMMUTABLE) {
    tx.run(
      sql.raw(
        `CREATE TRIGGER "${t}_no_delete" BEFORE DELETE ON "${t}" BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`,
      ),
    );
  }
};

function purgeIn(tx: PurgeTx, projectId: number): { stories: number } {
  // Deviation from the plan: drizzle transactions do not expose `$client`; the story ids
  // are read through the query builder instead of a raw better-sqlite3 statement.
  const storyIds = tx.select({ id: userStories.id }).from(userStories).where(eq(userStories.projectId, projectId)).all();
  const stories = storyIds.length;
  const IN = storyIds.length > 0 ? `(${storyIds.map((r) => String(r.id)).join(', ')})` : '(SELECT id FROM user_stories WHERE project_id = 0)';
  const S = `story_id IN ${IN}`;
  const stmts: string[] = [
    // Deviation from the plan: `model_usage.asset_run_id` does not exist in the schema
    // (migration 0000 defines only `agent_run_id`); the DELETE below already clears that FK stem.
    `DELETE FROM model_usage WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE ${S})`,
    `DELETE FROM plans WHERE ${S}`, // clarifications cascade via plans.story_id
    `DELETE FROM review_ac_results WHERE review_id IN (SELECT id FROM reviews WHERE ${S}) OR acceptance_criterion_id IN (SELECT id FROM acceptance_criteria WHERE ${S})`,
    `DELETE FROM review_findings WHERE review_id IN (SELECT id FROM reviews WHERE ${S})`,
    `DELETE FROM reviews WHERE ${S}`, // before agent_runs (reviews.agent_run_id → agent_runs)
    `DELETE FROM verification_checks WHERE verification_run_id IN (SELECT id FROM verification_runs WHERE ${S})`,
    `DELETE FROM verification_runs WHERE ${S}`,
    `DELETE FROM merges WHERE ${S}`, // before pull_requests (merges.pull_request_id)
    `DELETE FROM merge_approvals WHERE ${S}`,
    `DELETE FROM pull_requests WHERE ${S}`,
    `DELETE FROM durable_jobs WHERE ${S}`,
    `DELETE FROM story_events WHERE ${S}`,
    `DELETE FROM story_dependencies WHERE ${S} OR depends_on_story_id IN ${IN}`, // both FK stems
    `DELETE FROM agent_runs WHERE ${S}`, // after plans/reviews/model_usage are cleared
    `DELETE FROM workspaces WHERE ${S}`, // after agent_runs
    `DELETE FROM outbox_events WHERE ${S}`,
    `DELETE FROM user_stories WHERE project_id = ${projectId}`,
    `DELETE FROM remote_sync_runs WHERE project_id = ${projectId}`,
    `DELETE FROM role_routes WHERE project_id = ${projectId}`,
    `DELETE FROM projects WHERE id = ${projectId}`,
  ];
  dropTriggers(tx);
  try {
    for (const s of stmts) tx.run(sql.raw(`${s};`));
  } finally {
    recreateTriggers(tx); // arm the append-only guards again, even on failure
  }
  return { stories };
}
