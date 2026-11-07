import { STATION_ROLES, STORY_STATUS, type OfficeSnapshot, type STATION_STATES, type Role, type StationRole, type StoryStatus } from '@aik/contracts';
import { devZoneSeats, stationSeats } from '../layout/room.ts';
import { COMPLETED_WINDOW_MS, mapRole, type OfficeState } from './model.ts';

export type StationState = (typeof STATION_STATES)[number];
export type StationSeat = { runId: number | null; storyKey: string | null; state: StationState };
export type StationView = {
  state: StationState;
  seats: StationSeat[];
  overflow: number;
  stories: Array<{ storyId: number; storyKey: string; title: string | null; state: StationState }>;
};

const ACTIVE_STATE: Record<Role, StationState> = {
  planner: 'planning',
  implementer: 'working',
  reviewer: 'reviewing',
  security: 'reviewing',
  qa: 'testing',
};

const stationOf = (role: Role): StationRole => {
  const m = mapRole(role);
  return m === 'security' ? 'reviewer' : m;
};

/** Priority: error > active > completed > idle (active ranks by first seen). */
function worst(states: StationState[]): StationState {
  if (states.includes('error')) return 'error';
  const active = states.find((x) => x !== 'idle' && x !== 'completed');
  if (active) return active;
  if (states.includes('completed')) return 'completed';
  return 'idle';
}

type Entry = { storyId: number; storyKey: string; title: string | null; state: StationState; runId: number | null };

function entriesFor(s: OfficeState, roomId: number, role: StationRole, nowMs: number): Entry[] {
  const byStory = new Map<number, Entry>();
  const rank = (x: StationState) => (x === 'error' ? 3 : x === 'completed' ? 1 : 2);
  const put = (e: Entry) => {
    const prev = byStory.get(e.storyId);
    if (!prev || rank(e.state) > rank(prev.state) || (rank(e.state) === rank(prev.state) && prev.runId === null && e.runId !== null)) byStory.set(e.storyId, e);
  };
  const info = (id: number) => s.stories.get(id);

  for (const o of s.outcomes) {
    const st = info(o.storyId);
    if (!st || st.roomId !== roomId || o.role !== role) continue;
    if (o.state === 'completed' && nowMs - o.at >= COMPLETED_WINDOW_MS) continue;
    put({ storyId: o.storyId, storyKey: st.key, title: st.title, state: o.state, runId: null });
  }
  for (const r of s.runs.values()) {
    if (r.roomId !== roomId || stationOf(r.role) !== role) continue;
    put({ storyId: r.storyId, storyKey: r.storyKey, title: r.storyTitle ?? info(r.storyId)?.title ?? null, state: ACTIVE_STATE[r.role], runId: r.runId });
  }
  if (role === 'qa') {
    const hasQaRun = new Set<number>();
    for (const r of s.runs.values()) if (r.roomId === roomId && r.role === 'qa') hasQaRun.add(r.storyId);
    for (const q of s.qa.values()) {
      if (q.roomId !== roomId || hasQaRun.has(q.storyId)) continue;
      const running = Object.values(q.checks).some((v) => v === 'running');
      let state: StationState = 'idle';
      if (q.passed === false || (q.previousFailed === true && q.passed !== true)) state = 'error';
      else if (running) state = 'testing';
      else if (q.passed === true && q.finishedAt !== null && nowMs - q.finishedAt < COMPLETED_WINDOW_MS) state = 'completed';
      if (state !== 'idle') put({ storyId: q.storyId, storyKey: q.storyKey, title: info(q.storyId)?.title ?? null, state, runId: null });
    }
    for (const [storyId, rid] of s.testingStories) {
      if (rid !== roomId || hasQaRun.has(storyId)) continue;
      if (byStory.has(storyId)) continue;
      const st = info(storyId);
      put({ storyId, storyKey: st?.key ?? `#${storyId}`, title: st?.title ?? null, state: 'testing', runId: null });
    }
  }
  return [...byStory.values()].sort((a, b) => a.storyId - b.storyId);
}

function pmState(s: OfficeState, roomId: number): StationState {
  if (blockedOf(s, roomId).length > 0) return 'error';
  for (const r of s.runs.values()) if (r.roomId === roomId) return 'working';
  return 'idle';
}

function blockedOf(s: OfficeState, roomId: number): OfficeSnapshot['rooms'][number]['blocked'] {
  const snap = s.snapshot.get(roomId)?.blocked ?? [];
  const live = new Set(s.outcomes.filter((o) => o.reason === 'blocked').map((o) => o.storyId));
  const out = snap.filter((b) => live.has(b.storyId));
  const have = new Set(out.map((b) => b.storyId));
  for (const id of live) {
    const st = s.stories.get(id);
    if (!st || st.roomId !== roomId || have.has(id)) continue;
    out.push({ storyId: id, storyKey: st.key, title: st.title ?? '', reason: null });
  }
  return out;
}

export function stationViews(s: OfficeState, roomId: number, nowMs: number): Record<StationRole, StationView> {
  const out = {} as Record<StationRole, StationView>;
  for (const role of STATION_ROLES) {
    if (role === 'pm') {
      const state = pmState(s, roomId);
      out.pm = { state, seats: [{ runId: null, storyKey: null, state }], overflow: 0, stories: [] };
      continue;
    }
    const entries = entriesFor(s, roomId, role, nowMs);
    const state = worst(entries.map((e) => e.state));
    const isActive = (e: Entry) => e.state !== 'idle' && e.state !== 'completed' && e.state !== 'error';
    // Seat figures: every active run (runId set), plus verification-derived QA presence (runId null).
    const figures: Array<{ runId: number | null; storyKey: string; state: StationState }> = [];
    for (const r of [...s.runs.values()].sort((a, b) => a.runId - b.runId)) {
      if (r.roomId === roomId && stationOf(r.role) === role) figures.push({ runId: r.runId, storyKey: r.storyKey, state: ACTIVE_STATE[r.role] });
    }
    if (role === 'qa') {
      const covered = new Set(figures.map((f) => f.storyKey));
      for (const e of entries) if (e.runId === null && isActive(e) && !covered.has(e.storyKey)) figures.push({ runId: null, storyKey: e.storyKey, state: e.state });
    }
    const n = figures.length;
    const { seats, overflow } = role === 'implementer' ? devZoneSeats(n) : stationSeats(n);
    const seatList: StationSeat[] = Array.from({ length: seats }, (_, i) => {
      const f = figures[i];
      return f ? { runId: f.runId, storyKey: f.storyKey, state: f.state } : { runId: null, storyKey: null, state: n === 0 && i === 0 ? state : 'idle' };
    });
    out[role] = { state, seats: seatList, overflow, stories: entries.map((e) => ({ storyId: e.storyId, storyKey: e.storyKey, title: e.title, state: e.state })) };
  }
  return out;
}

export function pmView(
  s: OfficeState,
  roomId: number,
): { board: Record<StoryStatus, number>; blocked: OfficeSnapshot['rooms'][number]['blocked']; doneToday: number; state: StationState } {
  const snap = s.snapshot.get(roomId);
  const board = Object.fromEntries(STORY_STATUS.map((k) => [k, snap?.board[k] ?? 0])) as Record<StoryStatus, number>;
  return { board, blocked: blockedOf(s, roomId), doneToday: snap?.doneToday ?? 0, state: pmState(s, roomId) };
}

/** Whole-room light: error > any active > idle. */
export function roomAggregate(s: OfficeState, roomId: number, nowMs: number): StationState {
  const views = stationViews(s, roomId, nowMs);
  const states = STATION_ROLES.map((r) => views[r].state);
  if (states.includes('error')) return 'error';
  if (states.some((x) => x !== 'idle' && x !== 'completed')) return states.find((x) => x !== 'idle' && x !== 'completed')!;
  return 'idle';
}
