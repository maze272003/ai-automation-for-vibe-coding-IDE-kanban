// apps/orchestrator/src/maintenance/retention.ts
import {
  apiIdempotency,
  durableJobs,
  outboxEvents,
  userStories,
  workspaces,
  type AikDb,
} from '@aik/db';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

export interface PruneOptions {
  maxAgeDays?: number;
}

export interface PruneResult {
  prunedJobs: number;
  prunedOutboxEvents: number;
  prunedWorkspaces: number;
  prunedLogFiles: number;
}

export class RetentionService {
  private readonly db: AikDb;
  private readonly worktreeRoot?: string;
  private readonly logsDir?: string;

  constructor(deps: { db: AikDb; worktreeRoot?: string; logsDir?: string }) {
    this.db = deps.db;
    this.worktreeRoot = deps.worktreeRoot;
    this.logsDir = deps.logsDir;
  }

  async prune(options?: PruneOptions): Promise<PruneResult> {
    const maxAgeDays = options?.maxAgeDays ?? 30;
    const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000);

    // 1. Delete completed/terminal durable jobs older than cutoff
    let prunedJobs = 0;
    try {
      const deletedJobs = this.db
        .delete(durableJobs)
        .where(
          and(
            lt(durableJobs.updatedAt, cutoff),
            or(
              inArray(durableJobs.status, ['succeeded', 'cancelled']),
              and(
                inArray(durableJobs.status, ['failed', 'dead']),
                or(
                  isNull(durableJobs.storyId),
                  inArray(durableJobs.storyId, this.db.select({ id: userStories.id })
                    .from(userStories).where(inArray(userStories.status, ['DONE', 'CANCELLED']))),
                ),
              ),
            ),
          ),
        )
        .returning()
        .all();
      prunedJobs = deletedJobs.length;
    } catch {
      // ignore
    }

    // 2. Delete outbox events older than cutoff
    let prunedOutboxEvents = 0;
    try {
      const deletedOutbox = this.db
        .delete(outboxEvents)
        .where(lt(outboxEvents.createdAt, cutoff))
        .returning()
        .all();
      prunedOutboxEvents = deletedOutbox.length;
    } catch {
      // ignore
    }

    // 3. Delete expired API idempotency rows
    try {
      this.db
        .delete(apiIdempotency)
        .where(lt(apiIdempotency.createdAt, cutoff))
        .run();
    } catch {
      // ignore
    }

    // 4. Clean removed workspace directories from disk
    const removedWorkspaces = this.db
      .select({ id: workspaces.id, path: workspaces.path })
      .from(workspaces)
      .where(and(eq(workspaces.status, 'removed'), lt(workspaces.removedAt, cutoff)))
      .all();

    let prunedWorkspaces = 0;
    for (const ws of removedWorkspaces) {
      if (ws.path && fs.existsSync(ws.path)) {
        try {
          fs.rmSync(ws.path, { recursive: true, force: true });
          prunedWorkspaces++;
        } catch {
          // ignore disk removal failure
        }
      } else {
        prunedWorkspaces++;
      }
    }

    // 5. Clean expired log files from logsDir if present
    let prunedLogFiles = 0;
    if (this.logsDir && fs.existsSync(this.logsDir)) {
      try {
        const files = fs.readdirSync(this.logsDir);
        for (const file of files) {
          const filePath = path.join(this.logsDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.mtimeMs < cutoff.getTime()) {
              fs.unlinkSync(filePath);
              prunedLogFiles++;
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      prunedJobs,
      prunedOutboxEvents,
      prunedWorkspaces,
      prunedLogFiles,
    };
  }
}
