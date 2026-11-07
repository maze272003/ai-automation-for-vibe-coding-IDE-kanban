import type { AGENT_MOVEMENT, StationRole } from '@aik/contracts';

type AgentMovement = (typeof AGENT_MOVEMENT)[number];
import type { Vec2 } from '../layout/geometry.ts';
import { findPath, freeSpot, type SpotKind, type WaypointGraph } from '../layout/waypoints.ts';
import { ACTIVITY_SPOT, classifyActivity, truncateBubble, type Activity } from './activity.ts';
import { mapRole, type OfficeState, type QaRunView, type RunView } from './model.ts';

export const WALK_SPEED_MPS = 1.4;
export const MOVE_AFTER_MS = 3000;
export const MIN_DWELL_MS = 4000;
export const FAILURE_HOLD_MS = 5000;
export const PASSED_HOLD_MS = 3000;
export const DESK_LINGER_MS = 2000;

export type FigureState = {
  id: string; // 'run:<id>' | 'qa:<storyId>'
  roomId: number;
  role: StationRole;
  variant: number;
  spotId: string;
  path: Vec2[];
  pos: Vec2;
  activity: Activity;
  bubble: string;
  pending: { activity: Activity; since: number } | null;
  arrivedAt: number;
  leaving: false | 'done' | 'failed';
  leaveAt: number | null;
  /** The figure's own station seat, kept for its lifetime; also the full-spot fallback. */
  seatId: string;
  storyId: number;
  /** Failed checks the QA figure has already written up on the whiteboard. */
  ackedFails: string[];
};

type Desc = { id: string; roomId: number; role: StationRole; storyId: number; variant: number; run: RunView | null; qa: QaRunView | null };

const DEV_DOOR = 'door-dev';
const INTERNAL_DOOR = 'internal-door';
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

const stationOf = (r: RunView): StationRole => {
  const m = mapRole(r.role);
  return m === 'security' ? 'reviewer' : m;
};

function describeFigures(s: OfficeState, graphs: Map<number, WaypointGraph>): Desc[] {
  const live = (roomId: number) => s.rooms.get(roomId)?.state === 'active' && graphs.has(roomId);
  const out: Desc[] = [];
  const qaStories = new Set<number>();
  for (const r of [...s.runs.values()].sort((a, b) => a.runId - b.runId)) {
    if (!live(r.roomId)) continue;
    if (r.role === 'qa') qaStories.add(r.storyId);
    out.push({ id: `run:${r.runId}`, roomId: r.roomId, role: stationOf(r), storyId: r.storyId, variant: r.runId % 4, run: r, qa: null });
  }
  for (const q of [...s.qa.values()].sort((a, b) => a.storyId - b.storyId)) {
    if (!live(q.roomId) || qaStories.has(q.storyId)) continue;
    out.push({ id: `qa:${q.storyId}`, roomId: q.roomId, role: 'qa', storyId: q.storyId, variant: 0, run: null, qa: q });
  }
  return out;
}

const spotOf = (g: WaypointGraph, id: string) => g.spots.find((x) => x.id === id);

function occupiedBy(work: Map<string, FigureState>, roomId: number, exceptId: string): Set<string> {
  const occ = new Set<string>();
  for (const f of work.values()) if (f.roomId === roomId && f.id !== exceptId) occ.add(f.spotId);
  return occ;
}

function pickSeat(g: WaypointGraph, work: Map<string, FigureState>, roomId: number, role: StationRole): string | null {
  const seats = g.spots.filter((x) => x.kind === 'seat' && x.role === role).map((x) => x.id).sort();
  if (seats.length === 0) return null;
  const used = new Set<string>();
  let same = 0;
  for (const f of work.values()) {
    if (f.roomId === roomId && f.role === role) {
      used.add(f.seatId);
      same++;
    }
  }
  return seats.find((id) => !used.has(id)) ?? seats[same % seats.length]!;
}

/** Spot for an activity kind; a full (or missing) spot falls back to the figure's own seat. */
function resolveSpot(f: FigureState, kind: SpotKind, g: WaypointGraph, work: Map<string, FigureState>): string {
  if (kind === 'seat') return f.seatId;
  const k: SpotKind = f.role === 'qa' && (kind === 'sofa' || kind === 'coffee' || kind === 'huddle') ? 'lab-couch' : kind;
  return freeSpot(g, k, occupiedBy(work, f.roomId, f.id))?.id ?? f.seatId;
}

function walkTo(f: FigureState, g: WaypointGraph, toId: string): void {
  const to = spotOf(g, toId);
  if (!to) return;
  let path = f.spotId === toId ? [] : findPath(g, f.spotId, toId);
  if (path.length === 0 && f.spotId !== toId) path = [{ x: to.pos.x, z: to.pos.z }];
  f.spotId = toId;
  f.path = path;
}

function startLeaving(f: FigureState, g: WaypointGraph, why: 'done' | 'failed', bubble: string | null, nowMs: number, desk: boolean): void {
  f.leaving = why;
  f.leaveAt = nowMs;
  f.pending = null;
  if (bubble !== null) f.bubble = bubble;
  if (desk) return;
  const door = f.role === 'qa' ? INTERNAL_DOOR : DEV_DOOR;
  const out = findPath(g, f.spotId, door);
  const doorSpot = spotOf(g, door);
  const tail = out.length > 0 ? out.slice(1) : doorSpot ? [{ x: doorSpot.pos.x, z: doorSpot.pos.z }] : [];
  f.path = [...f.path, ...tail];
  f.spotId = door;
}

function qaDesire(q: QaRunView, f: FigureState): { activity: Activity; bubble: string } | { leave: 'done' | 'failed' } {
  const entries = Object.entries(q.checks);
  if (q.passed === true) return { activity: 'qa-passed', bubble: 'All checks passed ✓' };
  const unacked = entries.find(([k, v]) => v === 'failed' && !f.ackedFails.includes(k));
  if (unacked) return { activity: 'qa-failure', bubble: truncateBubble(`Writing up: ${unacked[0]} failed`) };
  const running = entries.find(([, v]) => v === 'running');
  if (running) return { activity: 'qa-testing', bubble: truncateBubble(`Testing: ${running[0]}`) };
  if (q.finishedAt !== null) return { leave: q.passed === false ? 'failed' : 'done' };
  const last = entries[entries.length - 1];
  return { activity: 'qa-testing', bubble: last ? truncateBubble(`Testing: ${last[0]}`) : 'Testing' };
}

function outcomeFor(s: OfficeState, f: FigureState): 'done' | 'failed' {
  let best: { at: number; state: string } | null = null;
  for (const o of s.outcomes) {
    if (o.storyId === f.storyId && o.role === f.role && (!best || o.at >= best.at)) best = o;
  }
  return best?.state === 'error' ? 'failed' : 'done';
}

function spawn(d: Desc, g: WaypointGraph, work: Map<string, FigureState>, s: OfficeState, nowMs: number, desk: boolean): FigureState | null {
  const seatId = pickSeat(g, work, d.roomId, d.role);
  const seat = seatId ? spotOf(g, seatId) : undefined;
  const doorId = d.role === 'qa' ? INTERNAL_DOOR : DEV_DOOR;
  const door = spotOf(g, doorId);
  if (!seatId || !seat || !door) return null;
  // A verification that already finished never (re)spawns a figure; only one in progress does.
  if (d.qa && (d.qa.finishedAt !== null || d.qa.passed !== null)) return null;
  const f: FigureState = {
    id: d.id, roomId: d.roomId, role: d.role, variant: d.variant, spotId: desk ? seatId : doorId,
    path: [], pos: desk ? { ...seat.pos } : { ...door.pos }, activity: 'tool', bubble: '', pending: null,
    arrivedAt: nowMs, leaving: false, leaveAt: null, seatId, storyId: d.storyId, ackedFails: [],
  };
  let kind: SpotKind = 'seat';
  if (d.run) {
    const last = s.lastActivity.get(d.run.runId) ?? null;
    const c = classifyActivity(last, { testCommand: null, idleMs: nowMs - (last?.at ?? d.run.startedAt) });
    f.bubble = c.bubble;
    f.activity = c.activity;
    kind = ACTIVITY_SPOT[c.activity];
  } else if (d.qa) {
    const want = qaDesire(d.qa, f);
    if ('leave' in want) return null;
    f.bubble = want.bubble;
    f.activity = want.activity;
    kind = ACTIVITY_SPOT[want.activity];
  }
  if (desk) {
    if (kind !== 'seat') f.activity = 'tool';
    return f;
  }
  walkTo(f, g, resolveSpot(f, kind, g, work));
  return f;
}

function updateRun(f: FigureState, d: Desc, s: OfficeState, g: WaypointGraph, work: Map<string, FigureState>, nowMs: number, desk: boolean): void {
  const run = d.run!;
  const last = s.lastActivity.get(run.runId) ?? null;
  const c = classifyActivity(last, { testCommand: null, idleMs: nowMs - (last?.at ?? run.startedAt) });
  f.bubble = c.bubble;
  if (desk) return;
  if (c.activity === f.activity) {
    f.pending = null;
  } else if (!f.pending || f.pending.activity !== c.activity) {
    f.pending = { activity: c.activity, since: nowMs };
  }
  const p = f.pending;
  if (p && nowMs - p.since >= MOVE_AFTER_MS && f.path.length === 0 && nowMs - f.arrivedAt >= MIN_DWELL_MS) {
    const target = resolveSpot(f, ACTIVITY_SPOT[p.activity], g, work);
    f.activity = p.activity;
    f.pending = null;
    if (target !== f.spotId) walkTo(f, g, target);
  }
}

function updateQa(f: FigureState, d: Desc, g: WaypointGraph, work: Map<string, FigureState>, nowMs: number, desk: boolean): void {
  const want = qaDesire(d.qa!, f);
  if ('leave' in want) {
    startLeaving(f, g, want.leave, want.leave === 'failed' ? 'Failed ✗' : 'Done ✓', nowMs, desk);
    return;
  }
  f.bubble = want.bubble;
  if (desk) return;
  if (want.activity !== f.activity && f.path.length === 0) {
    const target = resolveSpot(f, ACTIVITY_SPOT[want.activity], g, work);
    f.activity = want.activity;
    if (target !== f.spotId) walkTo(f, g, target);
    else f.arrivedAt = nowMs;
    f.leaveAt = null;
  }
  if (f.path.length === 0 && f.activity === 'qa-failure' && nowMs - f.arrivedAt >= FAILURE_HOLD_MS) {
    f.ackedFails = Object.entries(d.qa!.checks).filter(([, v]) => v === 'failed').map(([k]) => k);
  }
  if (f.path.length === 0 && f.activity === 'qa-passed') {
    if (f.leaveAt === null) f.leaveAt = nowMs + PASSED_HOLD_MS;
    else if (nowMs >= f.leaveAt) startLeaving(f, g, 'done', null, nowMs, desk);
  }
}

function walk(f: FigureState, distance: number): void {
  let left = distance;
  while (left > 0 && f.path.length > 0) {
    const next = f.path[0]!;
    const d = dist(f.pos, next);
    if (d <= left) {
      f.pos = { x: next.x, z: next.z };
      f.path = f.path.slice(1);
      left -= d;
    } else {
      f.pos = { x: f.pos.x + ((next.x - f.pos.x) / d) * left, z: f.pos.z + ((next.z - f.pos.z) / d) * left };
      left = 0;
    }
  }
}

/**
 * Pure figure simulation. One figure per active run (`run:<id>`) plus one per in-progress verification (`qa:<storyId>`);
 * figures are removed as soon as their room disappears or is archived.
 */
export function stepFigures(
  prev: Map<string, FigureState>,
  s: OfficeState,
  graphs: Map<number, WaypointGraph>,
  prefs: { agentMovement: AgentMovement },
  nowMs: number,
  dtMs: number,
): Map<string, FigureState> {
  if (prefs.agentMovement === 'off') return new Map();
  const desk = prefs.agentMovement === 'desk';
  const work = new Map<string, FigureState>();
  for (const [id, f] of prev) {
    if (s.rooms.get(f.roomId)?.state === 'active' && graphs.has(f.roomId)) work.set(id, { ...f, ackedFails: [...f.ackedFails] });
  }

  const desired = new Set<string>();
  for (const d of describeFigures(s, graphs)) {
    desired.add(d.id);
    const g = graphs.get(d.roomId)!;
    const f = work.get(d.id);
    if (!f) {
      const made = spawn(d, g, work, s, nowMs, desk);
      if (made) work.set(d.id, made);
      continue;
    }
    if (f.leaving) continue;
    if (d.run) updateRun(f, d, s, g, work, nowMs, desk);
    else updateQa(f, d, g, work, nowMs, desk);
  }
  for (const f of work.values()) {
    if (f.leaving || desired.has(f.id)) continue;
    const why = f.id.startsWith('run:') ? outcomeFor(s, f) : 'done';
    startLeaving(f, graphs.get(f.roomId)!, why, why === 'failed' ? 'Failed ✗' : 'Done ✓', nowMs, desk);
  }

  for (const f of [...work.values()]) {
    if (f.path.length > 0) {
      walk(f, (dtMs / 1000) * WALK_SPEED_MPS);
      if (f.path.length === 0) f.arrivedAt = nowMs;
    }
    if (f.leaving && f.path.length === 0 && (!desk || nowMs - (f.leaveAt ?? nowMs) >= DESK_LINGER_MS)) work.delete(f.id);
  }
  return work;
}

/** Failed checks of stories whose latest verification has not passed (cleared once it passes). */
export function whiteboardEntries(s: OfficeState, roomId: number): Array<{ storyKey: string; checkKey: string; summary: string }> {
  const out: Array<{ storyKey: string; checkKey: string; summary: string }> = [];
  for (const q of [...s.qa.values()].sort((a, b) => a.storyKey.localeCompare(b.storyKey))) {
    if (q.roomId !== roomId || q.passed === true) continue;
    for (const [checkKey, status] of Object.entries(q.checks).sort(([a], [b]) => a.localeCompare(b))) {
      if (status === 'failed') out.push({ storyKey: q.storyKey, checkKey, summary: `${checkKey} failed` });
    }
  }
  return out;
}
