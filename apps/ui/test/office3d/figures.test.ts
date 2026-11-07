import { describe, expect, test } from 'vitest';
import type { OfficeRoomDTO } from '@aik/contracts';
import { defaultRoomLayout } from '../../src/office3d/layout/room.ts';
import { buildWaypointGraph, type WaypointGraph } from '../../src/office3d/layout/waypoints.ts';
import { emptyOfficeState, type ActivityView, type OfficeState, type QaRunView, type RunView } from '../../src/office3d/state/model.ts';
import { ACTIVITY_SPOT, classifyActivity, type Activity } from '../../src/office3d/state/activity.ts';
import { stepFigures, whiteboardEntries, type FigureState } from '../../src/office3d/state/figures.ts';

const graph = buildWaypointGraph(defaultRoomLayout(), { implementer: 4, reviewer: 2 });
const graphs = new Map<number, WaypointGraph>([[1, graph]]);
const kindOf = (id: string) => graph.spots.find((s) => s.id === id)!.kind;
const ctx = { testCommand: null as string | null, idleMs: 0 };
const act = (kind: ActivityView['kind'], name?: string, summary?: string, runId = 1, at = 0): ActivityView => ({ runId, kind, name, summary, at });
const room = (id = 1, state: 'active' | 'archived' = 'active'): OfficeRoomDTO => ({
  id, state, projectId: id, projectKey: 'AIK', projectName: 'AIK', projectStatus: 'active', slot: null,
  customization: { signName: null, accentColor: '#f59e0b', icon: null, screens: null, layout: null } as never,
  createdAt: 0, updatedAt: 0, archivedAt: null,
});
const base = (): OfficeState => {
  const s = emptyOfficeState();
  s.rooms.set(1, room());
  return s;
};
const addRun = (s: OfficeState, runId: number, role: RunView['role'] = 'implementer', storyId = runId): void => {
  s.runs.set(runId, { runId, storyId, storyKey: `AIK-${storyId}`, storyTitle: null, role, roomId: 1, startedAt: 0 });
  s.stories.set(storyId, { roomId: 1, key: `AIK-${storyId}`, title: null, lastRole: null });
};
const setAct = (s: OfficeState, runId: number, kind: ActivityView['kind'], name: string | undefined, summary: string | undefined, at: number): void => {
  s.lastActivity.set(runId, { runId, kind, name, summary, at });
};
const alive = (s: OfficeState) => (t: number): OfficeState => {
  setAct(s, 1, 'tool-start', 'edit', 'a.ts', t);
  return s;
};
const full = { agentMovement: 'full' as const };
const DT = 100;
type StateSrc = OfficeState | ((t: number) => OfficeState);
const src = (s: StateSrc, t: number) => (typeof s === 'function' ? s(t) : s);
function run(prev: Map<string, FigureState>, s: StateSrc, from: number, to: number, prefs: { agentMovement: 'full' | 'desk' | 'off' } = full): Map<string, FigureState> {
  let m = prev;
  for (let t = from; t <= to; t += DT) m = stepFigures(m, src(s, t), graphs, prefs, t, DT);
  return m;
}
/** Steps until the figure has arrived at its spot; returns the arrival time. */
function untilArrived(prev: Map<string, FigureState>, s: StateSrc, id: string, from: number): { m: Map<string, FigureState>; t: number } {
  let m = prev;
  for (let t = from; t < from + 60_000; t += DT) {
    m = stepFigures(m, src(s, t), graphs, full, t, DT);
    const f = m.get(id);
    if (f && f.path.length === 0) return { m, t };
  }
  throw new Error('never arrived');
}

describe('classifyActivity', () => {
  test('maps tools to activities', () => {
    expect(classifyActivity(act('tool-start', 'read', 'api.ts'), ctx).bubble).toBe('Reading api.ts');
    expect(classifyActivity(act('tool-start', 'Grep', 'foo'), ctx).activity).toBe('reading');
    expect(classifyActivity(act('tool-start', 'edit', 'board.tsx'), ctx).activity).toBe('coding');
    expect(classifyActivity(act('tool-start', 'edit', 'board.tsx'), ctx).bubble).toBe('Coding board.tsx');
    expect(classifyActivity(act('tool-start', 'bash', 'npm run x'), ctx)).toEqual({ activity: 'running', bubble: 'Running npm run x' });
    expect(classifyActivity(act('tool-start', 'bash', 'npm test -- --run'), { ...ctx, testCommand: 'npm test' })).toEqual({ activity: 'testing-cmd', bubble: 'Testing' });
    expect(classifyActivity(act('tool-start', 'Thinking'), ctx)).toEqual({ activity: 'thinking', bubble: 'Thinking…' });
    expect(classifyActivity(act('message'), ctx)).toEqual({ activity: 'writing', bubble: 'Writing' });
    expect(classifyActivity(act('subagent', 'explorer'), ctx)).toEqual({ activity: 'delegating', bubble: 'Delegating to explorer' });
    expect(classifyActivity(act('tool-start', 'Zap'), ctx)).toEqual({ activity: 'tool', bubble: 'Using Zap' });
    expect(classifyActivity(null, { ...ctx, idleMs: 9000 }).activity).toBe('thinking');
    expect(classifyActivity(act('tool-start', 'read', 'a'), { ...ctx, idleMs: 9000 }).activity).toBe('thinking');
  });

  test('long summaries are truncated to 40 chars including the ellipsis', () => {
    const b = classifyActivity(act('tool-start', 'read', 'x'.repeat(80)), ctx).bubble;
    expect(b).toHaveLength(40);
    expect(b.endsWith('…')).toBe(true);
  });

  test('ACTIVITY_SPOT table', () => {
    const t: Record<Activity, string> = {
      reading: 'sofa', coding: 'seat', running: 'seat', 'testing-cmd': 'seat', writing: 'seat', tool: 'seat',
      thinking: 'coffee', delegating: 'huddle', 'qa-testing': 'test-board', 'qa-failure': 'whiteboard', 'qa-passed': 'test-board',
    };
    expect(ACTIVITY_SPOT).toEqual(t);
  });
});

describe('stepFigures', () => {
  test('new run spawns at the dev door and walks to its seat at 1.4 m/s', () => {
    const s = base();
    addRun(s, 5);
    const m0 = stepFigures(new Map(), s, graphs, full, 0, 0);
    const f = m0.get('run:5')!;
    const door = graph.spots.find((x) => x.id === 'door-dev')!.pos;
    expect(f.pos).toEqual(door);
    expect(f.variant).toBe(1);
    expect(f.roomId).toBe(1);
    expect(f.role).toBe('implementer');
    expect(kindOf(f.spotId)).toBe('seat');
    expect(f.path.length).toBeGreaterThan(0);
    const g = stepFigures(m0, s, graphs, full, 1000, 1000).get('run:5')!;
    const moved = Math.hypot(g.pos.x - door.x, g.pos.z - door.z);
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThanOrEqual(1.4 + 1e-6);
  });

  test('qa-role run spawns at the internal door', () => {
    const s = base();
    addRun(s, 7, 'qa');
    const door = graph.spots.find((x) => x.id === 'internal-door')!.pos;
    expect(stepFigures(new Map(), s, graphs, full, 0, 0).get('run:7')!.pos).toEqual(door);
  });

  test('security runs use reviewer seats; each figure keeps its own seat', () => {
    const s = base();
    addRun(s, 1, 'reviewer');
    addRun(s, 2, 'security');
    const m = run(new Map(), s, 0, 500);
    const a = m.get('run:1')!;
    const b = m.get('run:2')!;
    expect(b.role).toBe('reviewer');
    expect(a.spotId).toMatch(/^seat-reviewer-/);
    expect(b.spotId).toMatch(/^seat-reviewer-/);
    expect(a.spotId).not.toBe(b.spotId);
  });

  test('burst of alternating tools: bubble follows, figure stays put', () => {
    const s = base();
    addRun(s, 1);
    const { m: arrived, t } = untilArrived(new Map(), alive(s), 'run:1', 0);
    let m = run(arrived, alive(s), t, t + 4500);
    const seat = m.get('run:1')!.spotId;
    for (let i = 0; i < 25; i++) {
      const now = t + 4600 + i * 200;
      setAct(s, 1, 'tool-start', i % 2 ? 'edit' : 'read', i % 2 ? 'b.tsx' : 'a.ts', now);
      m = run(m, s, now, now + 199);
      expect(m.get('run:1')!.spotId).toBe(seat);
      expect(m.get('run:1')!.bubble).toBe(i % 2 ? 'Coding b.tsx' : 'Reading a.ts');
    }
  });

  test('reading for 3 s moves the figure to the sofa only after the minimum dwell', () => {
    const s = base();
    addRun(s, 1);
    const { m: arrived, t } = untilArrived(new Map(), alive(s), 'run:1', 0);
    const keep = (n: number): OfficeState => {
      setAct(s, 1, 'tool-start', 'read', 'a.ts', n);
      return s;
    };
    let m = run(arrived, keep, t, t + 3500);
    expect(kindOf(m.get('run:1')!.spotId)).toBe('seat');
    m = run(m, keep, t + 3500 + DT, t + 4200);
    expect(kindOf(m.get('run:1')!.spotId)).toBe('sofa');
    expect(m.get('run:1')!.path.length).toBeGreaterThan(0);
  });

  test('idle > 8 s sends the figure for coffee', () => {
    const s = base();
    addRun(s, 1);
    const { m: arrived, t } = untilArrived(new Map(), alive(s), 'run:1', 0);
    setAct(s, 1, 'tool-start', 'edit', 'a.ts', t);
    const m = run(arrived, s, t, t + 8000 + 3000 + 4500);
    expect(m.get('run:1')!.bubble).toBe('Thinking…');
    expect(kindOf(m.get('run:1')!.spotId)).toBe('coffee');
  });

  test('full sofa: the 4th reader stays at its own seat with the reading bubble', () => {
    const s = base();
    for (let i = 1; i <= 4; i++) {
      addRun(s, i);
      setAct(s, i, 'tool-start', 'read', 'a.ts', 0);
    }
    const m = run(new Map(), s, 0, 1000);
    const kinds = [1, 2, 3, 4].map((i) => kindOf(m.get(`run:${i}`)!.spotId));
    expect(kinds.filter((k) => k === 'sofa')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'seat')).toHaveLength(1);
    expect(m.get('run:4')!.bubble).toBe('Reading a.ts');
  });

  test('QA: running check → test board; failed → whiteboard held ≥ 5 s; passed → test board then leaves', () => {
    const s = base();
    const q: QaRunView = { storyId: 3, storyKey: 'AIK-3', roomId: 1, verificationRunId: 1, checks: { lint: 'running' }, startedAt: 0, finishedAt: null, passed: null };
    s.qa.set(3, q);
    let { m, t } = untilArrived(new Map(), s, 'qa:3', 0);
    expect(m.get('qa:3')!.bubble).toBe('Testing: lint');
    expect(m.get('qa:3')!.spotId).toBe('test-board');
    q.checks = { lint: 'failed', unit: 'running' };
    ({ m, t } = untilArrived(m, s, 'qa:3', t));
    const f = m.get('qa:3')!;
    expect(f.spotId).toBe('whiteboard');
    expect(f.bubble).toBe('Writing up: lint failed');
    const arrivedAt = t;
    m = run(m, s, t, arrivedAt + 4800);
    expect(m.get('qa:3')!.spotId).toBe('whiteboard');
    m = run(m, s, arrivedAt + 4800, arrivedAt + 6000);
    expect(m.get('qa:3')!.spotId).toBe('test-board');
    expect(m.get('qa:3')!.bubble).toBe('Testing: unit');
    q.checks = { lint: 'failed', unit: 'passed' };
    q.passed = true;
    q.finishedAt = arrivedAt + 7000;
    m = run(m, s, arrivedAt + 6000, arrivedAt + 8000);
    expect(m.get('qa:3')!.bubble).toBe('All checks passed ✓');
    m = run(m, s, arrivedAt + 8000, arrivedAt + 40_000);
    m = run(m, s, arrivedAt + 40_000, arrivedAt + 120_000);
    expect(m.has('qa:3')).toBe(false);
  });

  test('finished run walks out through the door and is removed', () => {
    const s = base();
    addRun(s, 1);
    const { m: arrived, t } = untilArrived(new Map(), s, 'run:1', 0);
    s.runs.delete(1);
    s.outcomes.push({ storyId: 1, role: 'implementer', state: 'completed', at: t });
    let m = run(arrived, s, t + DT, t + DT);
    const f = m.get('run:1')!;
    expect(f.bubble).toBe('Done ✓');
    expect(f.leaving).toBe('done');
    expect(f.path.length).toBeGreaterThan(0);
    m = run(m, s, t + 2 * DT, t + 60_000);
    expect(m.has('run:1')).toBe(false);
  });

  test('failed run shows Failed ✗', () => {
    const s = base();
    addRun(s, 1);
    const { m: arrived, t } = untilArrived(new Map(), s, 'run:1', 0);
    s.runs.delete(1);
    s.outcomes.push({ storyId: 1, role: 'implementer', state: 'error', at: t });
    const m = run(arrived, s, t + DT, t + DT);
    expect(m.get('run:1')!.bubble).toBe('Failed ✗');
    expect(m.get('run:1')!.leaving).toBe('failed');
  });

  test("agentMovement 'desk' never leaves the seat; 'off' renders nothing", () => {
    const s = base();
    addRun(s, 1);
    const reading = (t: number): OfficeState => {
      setAct(s, 1, 'tool-start', 'read', 'a.ts', t);
      return s;
    };
    const m = run(new Map(), reading, 0, 20_000, { agentMovement: 'desk' });
    const f = m.get('run:1')!;
    expect(kindOf(f.spotId)).toBe('seat');
    expect(f.path).toHaveLength(0);
    expect(f.bubble).toBe('Reading a.ts');
    expect(stepFigures(m, s, graphs, { agentMovement: 'off' }, 100, 100).size).toBe(0);
  });

  test('figures vanish when their room disappears or is archived', () => {
    const s = base();
    addRun(s, 1);
    const m = run(new Map(), s, 0, 500);
    expect(m.size).toBe(1);
    const arch = base();
    addRun(arch, 1);
    arch.rooms.set(1, room(1, 'archived'));
    expect(stepFigures(m, arch, graphs, full, 600, 100).size).toBe(0);
    const gone = base();
    gone.rooms.clear();
    addRun(gone, 1);
    expect(stepFigures(m, gone, graphs, full, 600, 100).size).toBe(0);
  });
});

describe('whiteboardEntries', () => {
  test('failed checks listed; cleared once the story passes', () => {
    const s = base();
    const q: QaRunView = { storyId: 3, storyKey: 'AIK-3', roomId: 1, verificationRunId: 1, checks: { lint: 'failed', unit: 'passed' }, startedAt: 0, finishedAt: 5, passed: false };
    s.qa.set(3, q);
    expect(whiteboardEntries(s, 1)).toEqual([{ storyKey: 'AIK-3', checkKey: 'lint', summary: 'lint failed' }]);
    expect(whiteboardEntries(s, 2)).toEqual([]);
    q.checks = { lint: 'passed', unit: 'passed' };
    q.passed = true;
    expect(whiteboardEntries(s, 1)).toEqual([]);
  });
});
