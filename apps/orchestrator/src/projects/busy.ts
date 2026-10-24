// apps/orchestrator/src/projects/busy.ts
import type { AikDb } from '@aik/db';

/** True while a queued/running agent run, a running verification or a running merge belongs to the project. */
export function projectBusyReason(db: AikDb, projectId: number): string | null {
  const merge = db.$client
    .prepare(`SELECT u.key FROM user_stories u JOIN merges m ON m.story_id = u.id WHERE u.project_id = ? AND m.status = 'running' LIMIT 1`)
    .get(projectId) as { key: string } | undefined;
  if (merge) return `Story ${merge.key} is merging right now — Git actions and delete pause until it finishes`;
  const run = db.$client
    .prepare(`SELECT u.key, r.status FROM user_stories u JOIN agent_runs r ON r.story_id = u.id WHERE u.project_id = ? AND r.status IN ('queued', 'running') LIMIT 1`)
    .get(projectId) as { key: string; status: string } | undefined;
  if (run) return `Story ${run.key} has a ${run.status} agent run in progress — Git actions and delete pause until it finishes`;
  const verify = db.$client
    .prepare(`SELECT u.key FROM user_stories u JOIN verification_runs v ON v.story_id = u.id WHERE u.project_id = ? AND v.status = 'running' LIMIT 1`)
    .get(projectId) as { key: string } | undefined;
  if (verify) return `Story ${verify.key} is in verification — Git actions and delete pause until it finishes`;
  return null;
}
