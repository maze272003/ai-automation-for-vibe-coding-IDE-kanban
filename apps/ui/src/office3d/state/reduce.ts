import { ROLE, type EventEnvelope, type Role, type StationRole } from '@aik/contracts';
import {
  COMPLETED_WINDOW_MS,
  mapRole,
  type ActivityView,
  type OfficeInput,
  type OfficeState,
  type QaRunView,
  type RunView,
  type StoryInfo,
} from './model.ts';

const FAILED_CHECK = new Set(['failed', 'error', 'timed_out']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLE as readonly string[]).includes(v);
const stationOf = (role: Role): StationRole => {
  const m = mapRole(role);
  return m === 'security' ? 'reviewer' : m;
};

function clone(s: OfficeState): OfficeState {
  return {
    rooms: new Map(s.rooms),
    roomByProjectKey: new Map(s.roomByProjectKey),
    snapshot: new Map(s.snapshot),
    runs: new Map(s.runs),
    outcomes: [...s.outcomes],
    qa: new Map(s.qa),
    lastActivity: new Map(s.lastActivity),
    testingStories: new Map(s.testingStories),
    stories: new Map(s.stories),
  };
}

function setStory(n: OfficeState, storyId: number, roomId: number, patch: Partial<StoryInfo>): void {
  const prev = n.stories.get(storyId);
  n.stories.set(storyId, {
    roomId,
    key: patch.key ?? prev?.key ?? `#${storyId}`,
    title: patch.title !== undefined ? patch.title : (prev?.title ?? null),
    lastRole: patch.lastRole !== undefined ? patch.lastRole : (prev?.lastRole ?? null),
  });
}

/** Replace the (story, role) outcome — a new run or result supersedes whatever was shown before. */
function setOutcome(n: OfficeState, o: OfficeState['outcomes'][number]): void {
  n.outcomes = n.outcomes.filter((x) => !(x.storyId === o.storyId && x.role === o.role));
  n.outcomes.push(o);
}

function clearBlocked(n: OfficeState, storyId: number): void {
  n.outcomes = n.outcomes.filter((x) => !(x.storyId === storyId && x.reason === 'blocked'));
}

function prune(n: OfficeState, nowMs: number): void {
  n.outcomes = n.outcomes.filter((o) => o.state === 'error' || nowMs - o.at < COMPLETED_WINDOW_MS);
  for (const [id, q] of n.qa) {
    if (q.passed === true && q.finishedAt !== null && nowMs - q.finishedAt >= COMPLETED_WINDOW_MS) n.qa.delete(id);
  }
}

function dropRoom(n: OfficeState, roomId: number): void {
  for (const [id, r] of n.runs) if (r.roomId === roomId) n.runs.delete(id);
  for (const [id, q] of n.qa) if (q.roomId === roomId) n.qa.delete(id);
  for (const [id, r] of n.testingStories) if (r === roomId) n.testingStories.delete(id);
  const gone = new Set<number>();
  for (const [id, st] of n.stories) if (st.roomId === roomId) gone.add(id);
  n.outcomes = n.outcomes.filter((o) => !gone.has(o.storyId));
  for (const id of gone) n.stories.delete(id);
  n.snapshot.delete(roomId);
  syncActivity(n);
}

function syncActivity(n: OfficeState): void {
  for (const id of n.lastActivity.keys()) if (!n.runs.has(id)) n.lastActivity.delete(id);
}

function reduceRooms(s: OfficeState, rooms: OfficeInput & { type: 'rooms' }): OfficeState {
  const n = clone(s);
  n.rooms = new Map(rooms.rooms.map((r) => [r.id, r]));
  n.roomByProjectKey = new Map();
  for (const r of rooms.rooms) if (r.state === 'active') n.roomByProjectKey.set(r.projectKey, r.id);
  const active = new Set([...n.roomByProjectKey.values()]);
  const known = new Set<number>();
  for (const r of n.runs.values()) known.add(r.roomId);
  for (const q of n.qa.values()) known.add(q.roomId);
  for (const st of n.stories.values()) known.add(st.roomId);
  for (const id of n.snapshot.keys()) known.add(id);
  for (const id of n.testingStories.values()) known.add(id);
  // Only rooms the list marks archived (or no longer lists after having been listed) lose their figures.
  for (const id of known) {
    if (active.has(id)) continue;
    if (s.rooms.has(id) || n.rooms.has(id)) dropRoom(n, id);
  }
  return n;
}

function reduceSnapshot(s: OfficeState, snap: OfficeSnapshotInput): OfficeState {
  const n = clone(s);
  for (const room of snap.rooms) {
    const dto = n.rooms.get(room.roomId);
    if (dto && dto.state !== 'active') continue;
    const id = room.roomId;
    // Wipe everything we hold for the room, then rebuild from the snapshot.
    const old = new Map<number, StoryInfo>();
    for (const [sid, st] of n.stories) if (st.roomId === id) old.set(sid, st);
    for (const [rid, r] of n.runs) if (r.roomId === id) n.runs.delete(rid);
    for (const [sid, q] of n.qa) if (q.roomId === id) n.qa.delete(sid);
    n.outcomes = n.outcomes.filter((o) => !old.has(o.storyId));
    n.snapshot.set(id, room);

    const lastRoleAt = new Map<number, number>();
    const learn = (storyId: number, key: string, title: string | null, role: Role | null, at: number) => {
      const prev = n.stories.get(storyId);
      const roleStation = role ? stationOf(role) : null;
      const newer = roleStation !== null && at >= (lastRoleAt.get(storyId) ?? -1);
      if (newer) lastRoleAt.set(storyId, at);
      setStory(n, storyId, id, {
        key,
        title: title ?? prev?.title ?? null,
        lastRole: newer ? roleStation : (prev?.lastRole ?? null),
      });
    };
    for (const r of room.activeRuns) {
      n.runs.set(r.runId, { runId: r.runId, storyId: r.storyId, storyKey: r.storyKey, storyTitle: r.storyTitle, role: r.role, roomId: id, startedAt: r.startedAt });
      learn(r.storyId, r.storyKey, r.storyTitle, r.role, r.startedAt);
    }
    // Latest finished run per (story, role) decides the lingering light.
    const latest = new Map<string, (typeof room.lastFinished)[number]>();
    for (const f of room.lastFinished) {
      const k = `${f.storyId}:${stationOf(f.role)}`;
      const p = latest.get(k);
      if (!p || f.endedAt >= p.endedAt) latest.set(k, f);
      learn(f.storyId, f.storyKey, null, f.role, f.endedAt);
    }
    const activeKeys = new Set(room.activeRuns.map((r) => `${r.storyId}:${stationOf(r.role)}`));
    for (const [k, f] of latest) {
      if (activeKeys.has(k)) continue;
      n.outcomes.push({ storyId: f.storyId, role: stationOf(f.role), state: f.status === 'succeeded' ? 'completed' : 'error', at: f.endedAt, ...(f.status !== 'succeeded' ? { reason: f.status } : {}) });
    }
    for (const b of room.blocked) {
      learn(b.storyId, b.storyKey, b.title, null, 0);
      const role = n.stories.get(b.storyId)?.lastRole ?? 'implementer';
      n.outcomes = n.outcomes.filter((o) => !(o.storyId === b.storyId && o.role === role));
      n.outcomes.push({ storyId: b.storyId, role, state: 'error', at: snap.generatedAt, reason: 'blocked' });
    }
    for (const v of room.verification) {
      learn(v.storyId, v.storyKey, null, null, 0);
      const checks: Record<string, string> = {};
      for (const c of v.checks) checks[c.checkKey] = c.status;
      const running = v.status === 'running';
      n.qa.set(v.storyId, {
        storyId: v.storyId, storyKey: v.storyKey, roomId: id, verificationRunId: v.verificationRunId, checks,
        startedAt: snap.generatedAt, finishedAt: running ? null : snap.generatedAt,
        passed: running ? null : v.status === 'passed',
      });
    }
  }
  syncActivity(n);
  return n;
}
type OfficeSnapshotInput = Extract<OfficeInput, { type: 'snapshot' }>['snapshot'];

function resolveRoom(s: OfficeState, projectKey: unknown): number | null {
  const k = str(projectKey);
  if (k === null) return null;
  return s.roomByProjectKey.get(k) ?? null;
}

function roomForStory(s: OfficeState, storyId: number, key: string | null): number | null {
  const known = s.stories.get(storyId);
  if (known) return known.roomId;
  if (key) {
    const m = /^(.*)-\d+$/.exec(key);
    if (m) return s.roomByProjectKey.get(m[1]!) ?? null;
  }
  return null;
}

function reduceEvent(s: OfficeState, e: EventEnvelope, nowMs: number): OfficeState {
  const d = e.data;
  if (!isObj(d)) return s;
  switch (e.topic) {
    case 'run.started': {
      const runId = num(d.runId);
      const storyKey = str(d.storyKey);
      const roomId = resolveRoom(s, d.projectKey);
      if (runId === null || e.storyId === null || storyKey === null || !isRole(d.role) || roomId === null) return s;
      const n = clone(s);
      prune(n, nowMs);
      const role = d.role;
      const prev = n.stories.get(e.storyId);
      const run: RunView = { runId, storyId: e.storyId, storyKey, storyTitle: prev?.title ?? null, role, roomId, startedAt: nowMs };
      n.runs.set(runId, run);
      setStory(n, e.storyId, roomId, { key: storyKey, lastRole: stationOf(role) });
      n.outcomes = n.outcomes.filter((o) => !(o.storyId === e.storyId && o.role === stationOf(role)));
      return n;
    }
    case 'run.finished': {
      const runId = num(d.runId);
      const storyKey = str(d.storyKey);
      const status = str(d.status);
      const roomId = resolveRoom(s, d.projectKey);
      if (runId === null || e.storyId === null || storyKey === null || status === null || !isRole(d.role) || roomId === null) return s;
      const n = clone(s);
      prune(n, nowMs);
      n.runs.delete(runId);
      n.lastActivity.delete(runId);
      const reason = str(d.exitReason);
      setStory(n, e.storyId, roomId, { key: storyKey, lastRole: stationOf(d.role) });
      setOutcome(n, {
        storyId: e.storyId,
        role: stationOf(d.role),
        state: status === 'succeeded' ? 'completed' : 'error',
        at: nowMs,
        ...(status !== 'succeeded' ? { reason: reason ?? status } : {}),
      });
      return n;
    }
    case 'run.activity': {
      const runId = num(d.runId);
      const roomId = resolveRoom(s, d.projectKey);
      if (runId === null || roomId === null || !Array.isArray(d.events)) return s;
      let act: ActivityView | null = null;
      let ended: ActivityView | null = null; // a tool-end only refreshes the timestamp; it never replaces what the run was doing
      for (const raw of d.events) {
        if (!isObj(raw)) continue;
        const kind = raw.kind;
        if (kind === 'tool-end') {
          ended = { runId, kind, at: nowMs, ...(str(raw.name) !== null ? { name: str(raw.name)! } : {}) };
        } else if (kind === 'tool-start') {
          act = { runId, kind, at: nowMs, ...(str(raw.name) !== null ? { name: str(raw.name)! } : {}), ...(str(raw.summary) !== null ? { summary: str(raw.summary)! } : {}) };
        } else if (kind === 'message') {
          const text = str(raw.text);
          if (text !== null) act = { runId, kind, at: nowMs, summary: text.length > 200 ? `${text.slice(0, 199)}…` : text };
        } else if (kind === 'subagent') {
          act = { runId, kind, at: nowMs, ...(str(raw.name) !== null ? { name: str(raw.name)! } : {}), ...(str(raw.phase) !== null ? { summary: str(raw.phase)! } : {}) };
        }
      }
      if (act) act = { ...act, at: nowMs };
      else if (ended) {
        const prior = s.lastActivity.get(runId);
        act = prior ? { ...prior, at: nowMs } : ended;
      }
      if (!act) return s;
      const n = clone(s);
      n.lastActivity.set(runId, act);
      return n;
    }
    case 'check.started':
    case 'check.finished': {
      const roomId = resolveRoom(s, d.projectKey);
      const storyId = num(d.storyId) ?? e.storyId;
      const vrun = num(d.verificationRunId);
      const checkKey = str(d.checkKey);
      if (roomId === null || storyId === null || vrun === null || checkKey === null) return s;
      const status = e.topic === 'check.finished' ? str(d.status) : 'running';
      if (status === null) return s;
      const storyKey = str(d.storyKey) ?? s.stories.get(storyId)?.key ?? `#${storyId}`;
      const n = clone(s);
      prune(n, nowMs);
      setStory(n, storyId, roomId, { key: storyKey });
      let q: QaRunView | undefined = n.qa.get(storyId);
      if (!q || q.verificationRunId !== vrun) {
        const prevFailed = q !== undefined && (q.passed === false || q.previousFailed === true) && q.passed !== true;
        q = { storyId, storyKey, roomId, verificationRunId: vrun, checks: {}, startedAt: nowMs, finishedAt: null, passed: null, ...(prevFailed ? { previousFailed: true } : {}) };
      }
      const checks = { ...q.checks, [checkKey]: status };
      const anyRunning = Object.values(checks).some((v) => v === 'running');
      const anyFailed = Object.values(checks).some((v) => FAILED_CHECK.has(v));
      const next: QaRunView = { ...q, checks };
      if (anyFailed) {
        next.passed = false;
        next.finishedAt = anyRunning ? null : nowMs;
      } else if (anyRunning) {
        next.passed = null;
        next.finishedAt = null;
      } else {
        next.passed = true;
        next.finishedAt = nowMs;
        delete next.previousFailed;
      }
      n.qa.set(storyId, next);
      return n;
    }
    case 'story.transitioned': {
      const storyId = e.storyId;
      const key = str(d.key);
      const to = str(d.to);
      if (storyId === null || to === null) return s;
      const roomId = roomForStory(s, storyId, key);
      if (roomId === null || !new Set(s.roomByProjectKey.values()).has(roomId)) return s;
      const n = clone(s);
      prune(n, nowMs);
      setStory(n, storyId, roomId, key ? { key } : {});
      if (to === 'BLOCKED') {
        const role = n.stories.get(storyId)?.lastRole ?? 'implementer';
        setOutcome(n, { storyId, role, state: 'error', at: nowMs, reason: 'blocked' });
      } else {
        clearBlocked(n, storyId);
      }
      if (to === 'TESTING') n.testingStories.set(storyId, roomId);
      else n.testingStories.delete(storyId);
      if (to !== 'TESTING' && to !== 'REWORK') {
        const q = n.qa.get(storyId);
        if (q && q.passed !== true) n.qa.delete(storyId);
      }
      return n;
    }
    default:
      return s;
  }
}

export function reduceOffice(s: OfficeState, input: OfficeInput, nowMs: number): OfficeState {
  try {
    switch (input.type) {
      case 'rooms':
        return reduceRooms(s, input);
      case 'snapshot':
        return reduceSnapshot(s, input.snapshot);
      case 'event':
        return reduceEvent(s, input.event, nowMs);
    }
  } catch {
    return s;
  }
}
