import { storyEvents, type AikDbOrTx } from '@aik/db';
import { and, desc, eq, sql } from 'drizzle-orm';

const normalizedPaths = (paths: readonly string[]): string[] => [...new Set(paths.map((path) => path.replaceAll('\\', '/')))].sort();

export function protectedPathsForCandidate(db: AikDbOrTx, storyId: number, candidateSha: string): string[] {
  const row = db.select({ payload: storyEvents.payload }).from(storyEvents).where(and(
    eq(storyEvents.storyId, storyId),
    eq(storyEvents.type, 'transition'),
    sql`json_extract(${storyEvents.payload}, '$.event.type') = 'candidate_committed'`,
    sql`json_extract(${storyEvents.payload}, '$.event.candidateSha') = ${candidateSha}`,
  )).orderBy(desc(storyEvents.id)).limit(1).get();
  const event = row?.payload?.event as { protectedPaths?: unknown } | undefined;
  const paths = event?.protectedPaths;
  return normalizedPaths(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []);
}

export function sameProtectedPaths(a: readonly string[], b: readonly string[]): boolean {
  const first = normalizedPaths(a);
  const second = normalizedPaths(b);
  return first.length === second.length && first.every((path, index) => path === second[index]);
}
