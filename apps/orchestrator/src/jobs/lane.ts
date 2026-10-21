// apps/orchestrator/src/jobs/lane.ts — job lanes (the unit of concurrency).
import crypto from 'node:crypto';

/** Normalizes a repository path so the same checkout maps to the same lane on Windows and POSIX. */
export function normalizeRepoPath(repoPath: string): string {
  return repoPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The heavy lane of a repository.
 *
 * The queue serializes work per lane, so a lane is a concurrency boundary: one heavy job at a
 * time inside a lane, while different lanes run in parallel. Narrowing the heavy lane from
 * "one for the whole app" to "one per repository" lets independent projects make progress at
 * the same time (spec ADV-1) without ever letting two jobs touch the same checkout — two
 * projects on the same repository share a lane and stay serialized.
 *
 * The path is hashed so the lane stays short and does not leak the local folder layout.
 */
export function heavyLane(repoPath: string): string {
  const hash = crypto.createHash('sha256').update(normalizeRepoPath(repoPath)).digest('hex').slice(0, 16);
  return `heavy:repo:${hash}`;
}
