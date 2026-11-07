import { STORY_STATUS, type OfficeRoomSnapshot, type OfficeSnapshot, type StoryStatus } from '@aik/contracts';
import { agentRuns, officeRooms, storyEvents, userStories, verificationChecks, verificationRuns, type AikDb } from '@aik/db';
import { and, asc, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Clock } from '../time.ts';

const FINISHED_WINDOW_MS = 10 * 60_000;
const SUMMARY_MAX = 200;
const FINISHED = ['succeeded', 'failed', 'interrupted'] as const;

function lastLine(tail: string | null): string {
  const line = (tail ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
  return line.slice(0, SUMMARY_MAX);
}

function roomSnapshot(db: AikDb, roomId: number, projectId: number, now: number, midnight: number): OfficeRoomSnapshot {
  const stories = db.select().from(userStories).where(eq(userStories.projectId, projectId)).orderBy(asc(userStories.id)).all();
  const byId = new Map(stories.map((s) => [s.id, s]));
  const ids = stories.map((s) => s.id);

  const board = Object.fromEntries(STORY_STATUS.map((s) => [s, 0])) as Record<StoryStatus, number>;
  for (const s of stories) board[s.status] += 1;

  const blocked = stories
    .filter((s) => s.status === 'BLOCKED')
    .map((s) => ({ storyId: s.id, storyKey: s.key, title: s.title, reason: s.blockedReason }));

  let doneToday = 0;
  let activeRuns: OfficeRoomSnapshot['activeRuns'] = [];
  const lastFinished: OfficeRoomSnapshot['lastFinished'] = [];
  const verification: OfficeRoomSnapshot['verification'] = [];

  if (ids.length > 0) {
    doneToday = new Set(
      db.select({ storyId: storyEvents.storyId }).from(storyEvents)
        .where(and(inArray(storyEvents.storyId, ids), eq(storyEvents.toStatus, 'DONE'), gte(storyEvents.createdAt, new Date(midnight))))
        .all().map((e) => e.storyId),
    ).size;

    activeRuns = db.select().from(agentRuns)
      .where(and(inArray(agentRuns.storyId, ids), eq(agentRuns.status, 'running')))
      .orderBy(asc(agentRuns.id)).all()
      .map((r) => ({ runId: r.id, storyId: r.storyId, storyKey: byId.get(r.storyId)!.key, storyTitle: byId.get(r.storyId)!.title, role: r.role, startedAt: (r.startedAt ?? new Date(now)).getTime() }));

    const seen = new Set<string>();
    const finished = db.select().from(agentRuns)
      .where(and(inArray(agentRuns.storyId, ids), inArray(agentRuns.status, [...FINISHED]), isNotNull(agentRuns.endedAt), gte(agentRuns.endedAt, new Date(now - FINISHED_WINDOW_MS))))
      .orderBy(desc(agentRuns.endedAt), desc(agentRuns.id)).all();
    for (const r of finished) {
      const k = `${r.storyId}:${r.role}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lastFinished.push({ runId: r.id, storyId: r.storyId, storyKey: byId.get(r.storyId)!.key, role: r.role, status: r.status as (typeof FINISHED)[number], endedAt: r.endedAt!.getTime() });
    }

    for (const s of stories.filter((x) => x.status === 'TESTING' || x.status === 'REWORK')) {
      const vr = db.select().from(verificationRuns)
        .where(and(eq(verificationRuns.storyId, s.id), eq(verificationRuns.trigger, 'candidate')))
        .orderBy(desc(verificationRuns.id)).limit(1).get();
      if (!vr) continue;
      const checks = db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, vr.id)).orderBy(asc(verificationChecks.id)).all();
      verification.push({
        storyId: s.id, storyKey: s.key, verificationRunId: vr.id, status: vr.status,
        checks: checks.map((c) => ({
          checkKey: c.checkKey, status: c.status, summary: lastLine(c.outputTail), mandatory: c.mandatory,
          durationMs: Math.max(0, c.endedAt.getTime() - c.startedAt.getTime()),
        })),
      });
    }
  }

  return { roomId, projectId, board, blocked, doneToday, activeRuns, lastFinished, verification };
}

/** One read-only call: live state for every active office room. */
export function buildOfficeSnapshot(db: AikDb, now: Clock): OfficeSnapshot {
  const t = now();
  const midnight = new Date(t);
  midnight.setHours(0, 0, 0, 0);
  const rooms = db.select().from(officeRooms)
    .where(and(eq(officeRooms.state, 'active'), isNotNull(officeRooms.projectId)))
    .orderBy(asc(officeRooms.id)).all();
  return {
    generatedAt: t,
    rooms: rooms.map((r) => roomSnapshot(db, r.id, r.projectId!, t, midnight.getTime())),
  };
}
