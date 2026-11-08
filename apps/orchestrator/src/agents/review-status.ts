// apps/orchestrator/src/agents/review-status.ts
// W0-7: a resumed review must be re-queued. A BLOCKED review blocks the story at write time
// (reviewer finishReview), so a READY_FOR_REVIEW story whose only review for the candidate SHA
// is BLOCKED was resumed after the block: that round never settled and the story must be
// reviewed again. `review_story_sha_idx` is not unique, so a second review row is allowed.
import { reviews, type AikDbOrTx } from '@aik/db';
import { and, desc, eq, ne } from 'drizzle-orm';

/**
 * The newest review for (story, commit) whose verdict settled the review round — anything but
 * BLOCKED. BLOCKED rows are skipped on purpose: they never settle a round, they block the story.
 */
export function settledReviewFor(
  db: AikDbOrTx,
  storyId: number,
  commitSha: string,
): { id: number; verdict: 'APPROVED' | 'CHANGES_REQUESTED' } | null {
  const row = db
    .select({ id: reviews.id, verdict: reviews.verdict })
    .from(reviews)
    .where(and(
      eq(reviews.storyId, storyId),
      eq(reviews.commitSha, commitSha),
      ne(reviews.verdict, 'BLOCKED'),
    ))
    .orderBy(desc(reviews.id))
    .limit(1)
    .get();
  return row && row.verdict !== 'BLOCKED' ? row : null;
}
