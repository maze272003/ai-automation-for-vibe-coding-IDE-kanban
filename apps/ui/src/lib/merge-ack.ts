// apps/ui/src/lib/merge-ack.ts
import type { StoryDTO } from '@aik/contracts';
import { ApiRequestError } from './api.ts';

/** Body of an approve_merge transition; the acknowledgement fields are sent only when applicable. */
export interface ApproveMergeBody {
  event: 'approve_merge';
  sha: string;
  expectedVersion: number;
  acknowledgedProtectedPaths?: string[];
  note?: string;
}

/**
 * Builds the approve_merge body: ack list only when the candidate touched protected paths, note only when non-blank.
 * `acknowledged` mirrors the checkbox that gates the button via canApproveMerge; it does not change the body.
 */
export function approveMergeBody(
  story: Pick<StoryDTO, 'candidateSha' | 'statusVersion'>,
  protectedPaths: readonly string[],
  acknowledged: boolean,
  note: string,
): ApproveMergeBody {
  const body: ApproveMergeBody = {
    event: 'approve_merge',
    // The Approve & Merge control is only reachable for stories that have a merge candidate.
    sha: story.candidateSha!,
    expectedVersion: story.statusVersion,
  };
  if (protectedPaths.length > 0) body.acknowledgedProtectedPaths = [...protectedPaths];
  const trimmed = note.trim();
  if (trimmed !== '') body.note = trimmed;
  return body;
}

/** Approve & Merge is enabled without protected paths, or once the user has acknowledged them. */
export function canApproveMerge(protectedPaths: readonly string[], acknowledged: boolean): boolean {
  return protectedPaths.length === 0 || acknowledged;
}

/** True when a rejected approve_merge failed because the protected-path list changed under the user. */
export function isProtectedPathsGuardError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.failedGuards.some((g) => g.guard === 'protected_paths_acknowledged');
}
