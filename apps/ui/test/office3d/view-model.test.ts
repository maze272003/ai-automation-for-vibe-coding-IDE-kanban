import { describe, expect, test } from 'vitest';
import { STORY_STATUS, type EventEnvelope, type OfficeRoomDTO, type OfficeSnapshot } from '@aik/contracts';
import { emptyOfficeState, mapRole, type OfficeInput, type OfficeState } from '../../src/office3d/state/model.ts';
import { reduceOffice } from '../../src/office3d/state/reduce.ts';
import { pmView, roomAggregate, stationViews } from '../../src/office3d/state/selectors.ts';

const T = 1_000_000;
let seq = 0;
const ev = (topic: EventEnvelope['topic'], data: unknown, storyId: number | null = 1): EventEnvelope => ({
  seq: ++seq, topic, storyId, at: T, provenance: 'system', data,
});
const room = (id: number, projectKey: string, state: 'active' | 'archived' = 'active'): OfficeRoomDTO => ({
  id, state, projectId: id * 10, projectKey, projectName: projectKey, projectStatus: 'active', slot: null,
  customization: { signName: null, accentColor: '#f59e0b', icon: null, screens: null, layout: null } as never,
  createdAt: 0, updatedAt: 0, archivedAt: null,
});
const feed = (s: OfficeState, ...inputs: Array<OfficeInput | EventEnvelope>) =>
  inputs.reduce<OfficeState>((acc, i) => reduceOffice(acc, 'type' in i && (i.type === 'rooms' || i.type === 'snapshot' || i.type === 'event') ? (i as OfficeInput) : { type: 'event', event: i as EventEnvelope }, T), s);
const withRoom = () => reduceOffice(emptyOfficeState(), { type: 'rooms', rooms: [room(1, 'AIK')] }, T);
const R = 1;
const start = (runId: number, role: string, storyId = 1, key = 'AIK-1') =>
  ev('run.started', { runId, role, storyKey: key, projectKey: 'AIK' }, storyId);
const finish = (runId: number, role: string, status: string, storyId = 1, key = 'AIK-1') =>
  ev('run.finished', { runId, role, storyKey: key, projectKey: 'AIK', status }, storyId);
const at = (s: OfficeState, input: EventEnvelope, now: number) => reduceOffice(s, { type: 'event', event: input }, now);

describe('office view-model', () => {
  test('run.started for implementer → working seat', () => {
    const s = at(withRoom(), start(5, 'implementer'), T);
    const v = stationViews(s, R, T);
    expect(v.implementer.state).toBe('working');
    expect(v.implementer.seats.some((x) => x.runId === 5)).toBe(true);
    expect(v.planner.state).toBe('idle');
    expect(roomAggregate(s, R, T)).toBe('working');
    expect(pmView(s, R).state).toBe('working');
  });

  test('planner/reviewer active states', () => {
    const s = feed(withRoom(), start(1, 'planner', 1, 'AIK-1'), start(2, 'reviewer', 2, 'AIK-2'));
    const v = stationViews(s, R, T);
    expect(v.planner.state).toBe('planning');
    expect(v.reviewer.state).toBe('reviewing');
  });

  test('succeeded shows completed for 60 s then idle', () => {
    let s = at(withRoom(), start(5, 'planner'), T);
    s = at(s, finish(5, 'planner', 'succeeded'), T);
    expect(stationViews(s, R, T + 59_000).planner.state).toBe('completed');
    expect(stationViews(s, R, T + 61_000).planner.state).toBe('idle');
    expect(s.runs.size).toBe(0);
  });

  test('error is per story and beats active state', () => {
    let s = withRoom();
    s = at(s, start(1, 'implementer', 1, 'AIK-1'), T);
    s = at(s, finish(1, 'implementer', 'failed', 1, 'AIK-1'), T);
    s = at(s, start(2, 'implementer', 2, 'AIK-2'), T);
    const v = stationViews(s, R, T + 1000).implementer;
    expect(v.state).toBe('error');
    expect(v.stories).toEqual([
      { storyId: 1, storyKey: 'AIK-1', title: null, state: 'error' },
      { storyId: 2, storyKey: 'AIK-2', title: null, state: 'working' },
    ]);
    expect(roomAggregate(s, R, T)).toBe('error');
  });

  test('interrupted counts as error and error persists past 60 s', () => {
    let s = at(withRoom(), start(1, 'reviewer'), T);
    s = at(s, finish(1, 'reviewer', 'interrupted'), T);
    expect(stationViews(s, R, T + 600_000).reviewer.state).toBe('error');
  });

  test('error clears when that story re-runs the role', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    s = at(s, finish(1, 'implementer', 'failed'), T);
    expect(stationViews(s, R, T).implementer.state).toBe('error');
    s = at(s, start(2, 'implementer'), T);
    expect(stationViews(s, R, T).implementer.state).toBe('working');
  });

  test('BLOCKED keeps error until the story leaves BLOCKED', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    s = at(s, finish(1, 'implementer', 'succeeded'), T);
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'IN_PROGRESS', to: 'BLOCKED' }), T + 1000);
    expect(stationViews(s, R, T + 600_000).implementer.state).toBe('error');
    expect(pmView(s, R).state).toBe('error');
    expect(pmView(s, R).blocked.map((b) => b.storyKey)).toEqual(['AIK-1']);
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'BLOCKED', to: 'READY' }), T + 700_000);
    expect(stationViews(s, R, T + 700_000).implementer.state).toBe('idle');
    expect(pmView(s, R).state).toBe('idle');
  });

  test('transitions for unknown stories are ignored; key prefix resolves the room', () => {
    const s0 = withRoom();
    expect(at(s0, ev('story.transitioned', { key: 'ZZZ-9', from: 'NEW', to: 'TESTING' }, 9), T)).toBe(s0);
    const s1 = at(s0, ev('story.transitioned', { key: 'AIK-9', from: 'READY', to: 'TESTING' }, 9), T);
    expect(stationViews(s1, R, T).qa.state).toBe('testing');
  });

  test('QA: check.started → testing; failed finish → error with check in qa entry', () => {
    const base = { storyId: 1, storyKey: 'AIK-1', projectKey: 'AIK', verificationRunId: 7 };
    let s = at(withRoom(), ev('check.started', { ...base, checkKey: 'lint' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('testing');
    s = at(s, ev('check.finished', { ...base, checkKey: 'lint', status: 'failed' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('error');
    expect(s.qa.get(1)!.checks.lint).toBe('failed');
  });

  test('QA failure persists through the next verification until it passes', () => {
    const base = { storyId: 1, storyKey: 'AIK-1', projectKey: 'AIK' };
    let s = at(withRoom(), ev('check.started', { ...base, verificationRunId: 7, checkKey: 'lint' }), T);
    s = at(s, ev('check.finished', { ...base, verificationRunId: 7, checkKey: 'lint', status: 'failed' }), T);
    s = at(s, ev('check.started', { ...base, verificationRunId: 8, checkKey: 'lint' }), T + 10);
    expect(stationViews(s, R, T + 10).qa.state).toBe('error');
    s = at(s, ev('check.finished', { ...base, verificationRunId: 8, checkKey: 'lint', status: 'passed' }), T + 20);
    expect(stationViews(s, R, T + 20).qa.state).toBe('completed');
    expect(stationViews(s, R, T + 20 + 61_000).qa.state).toBe('idle');
  });

  test('QA error clears when the story leaves TESTING/REWORK; stays during REWORK', () => {
    const base = { storyId: 1, storyKey: 'AIK-1', projectKey: 'AIK', verificationRunId: 7 };
    let s = at(withRoom(), ev('story.transitioned', { key: 'AIK-1', from: 'IN_PROGRESS', to: 'TESTING' }), T);
    s = at(s, ev('check.started', { ...base, checkKey: 'lint' }), T);
    s = at(s, ev('check.finished', { ...base, checkKey: 'lint', status: 'timed_out' }), T);
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'TESTING', to: 'REWORK' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('error');
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'REWORK', to: 'IN_PROGRESS' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('idle');
  });

  test('story in TESTING → qa testing; leaving TESTING clears it', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'IN_PROGRESS', to: 'TESTING' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('testing');
    s = at(s, ev('story.transitioned', { key: 'AIK-1', from: 'TESTING', to: 'READY_FOR_REVIEW' }), T);
    expect(stationViews(s, R, T).qa.state).toBe('idle');
  });

  test('qa-role run is shown in the qa station', () => {
    const s = at(withRoom(), start(3, 'qa'), T);
    expect(stationViews(s, R, T).qa.seats.some((x) => x.runId === 3)).toBe(true);
    expect(stationViews(s, R, T).qa.state).toBe('testing');
  });

  test('security run renders in reviewer station', () => {
    const s = at(withRoom(), start(9, 'security'), T);
    const v = stationViews(s, R, T);
    expect(v.reviewer.seats.some((x) => x.runId === 9)).toBe(true);
    expect(v.reviewer.state).toBe('reviewing');
    expect(mapRole('security')).toBe('security');
    expect(mapRole('implementer')).toBe('implementer');
  });

  test('events for unknown/archived project are ignored', () => {
    const s = withRoom();
    expect(reduceOffice(s, { type: 'event', event: ev('run.started', { runId: 1, role: 'planner', storyKey: 'N-1', projectKey: 'NOPE' }) }, T)).toEqual(s);
    const arch = reduceOffice(s, { type: 'rooms', rooms: [room(1, 'AIK', 'archived')] }, T);
    expect(reduceOffice(arch, { type: 'event', event: start(1, 'planner') }, T)).toBe(arch);
  });

  test('malformed events never throw and are ignored', () => {
    const s = withRoom();
    for (const data of [null, 5, 'x', [], {}, { runId: 'a', role: 'planner', storyKey: 'k', projectKey: 'AIK' }, { runId: 1, role: 'wizard', storyKey: 'k', projectKey: 'AIK' }]) {
      for (const t of ['run.started', 'run.finished', 'run.activity', 'check.started', 'check.finished', 'story.transitioned'] as const) {
        expect(reduceOffice(s, { type: 'event', event: ev(t, data) }, T)).toBe(s);
      }
    }
    expect(reduceOffice(s, { type: 'event', event: ev('office.rooms_changed', { roomIds: [1] }) }, T)).toBe(s);
    expect(reduceOffice(s, { type: 'event', event: ev('system.resync', {}) }, T)).toBe(s);
  });

  test('run.activity keeps the last non-usage event per run; cleared on finish', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    s = at(s, ev('run.activity', {
      runId: 1, role: 'implementer', storyKey: 'AIK-1', projectKey: 'AIK',
      events: [{ kind: 'tool-start', name: 'Read', summary: 'a.ts' }, { kind: 'message', text: 'hello' }, { kind: 'usage', tokens: 3 }],
    }), T + 5);
    expect(s.lastActivity.get(1)).toMatchObject({ kind: 'message', summary: 'hello' });
    s = at(s, ev('run.activity', { runId: 1, role: 'implementer', storyKey: 'AIK-1', projectKey: 'AIK', events: [{ kind: 'tool-end', name: 'Read' }] }), T + 6);
    expect(s.lastActivity.get(1)).toMatchObject({ kind: 'tool-end', name: 'Read' });
    const only = at(s, ev('run.activity', { runId: 1, role: 'implementer', storyKey: 'AIK-1', projectKey: 'AIK', events: [{ kind: 'usage' }] }), T);
    expect(only).toBe(s);
    s = at(s, finish(1, 'implementer', 'succeeded'), T);
    expect(s.lastActivity.has(1)).toBe(false);
  });

  test('archiving a room drops its figures', () => {
    let s = feed(withRoom(), start(1, 'implementer'), ev('check.started', { storyId: 1, storyKey: 'AIK-1', projectKey: 'AIK', verificationRunId: 1, checkKey: 'lint' }));
    s = at(s, ev('run.activity', { runId: 1, role: 'implementer', storyKey: 'AIK-1', projectKey: 'AIK', events: [{ kind: 'message', text: 'x' }] }), T);
    s = reduceOffice(s, { type: 'rooms', rooms: [room(1, 'AIK', 'archived')] }, T);
    expect(s.runs.size).toBe(0);
    expect(s.qa.size).toBe(0);
    expect(s.lastActivity.size).toBe(0);
    expect(s.roomByProjectKey.size).toBe(0);
  });

  const snap = (over: Partial<OfficeSnapshot['rooms'][number]> = {}): OfficeSnapshot => ({
    generatedAt: T,
    rooms: [{
      roomId: 1, projectId: 10,
      board: { NEW: 1, READY: 2 } as never, blocked: [], doneToday: 3, activeRuns: [], lastFinished: [], verification: [], ...over,
    }],
  });

  test('snapshot replaces runs (resync)', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    s = reduceOffice(s, {
      type: 'snapshot',
      snapshot: snap({ activeRuns: [{ runId: 2, storyId: 2, storyKey: 'AIK-2', storyTitle: 'Two', role: 'planner', startedAt: T - 5 }] }),
    }, T);
    expect([...s.runs.keys()]).toEqual([2]);
    expect(stationViews(s, R, T).planner.state).toBe('planning');
    expect(stationViews(s, R, T).implementer.state).toBe('idle');
    expect(stationViews(s, R, T).planner.stories[0]!.title).toBe('Two');
  });

  test('snapshot: lastFinished, blocked and verification seed outcomes', () => {
    const s = reduceOffice(withRoom(), {
      type: 'snapshot',
      snapshot: snap({
        lastFinished: [{ runId: 1, storyId: 1, storyKey: 'AIK-1', role: 'planner', status: 'succeeded', endedAt: T - 10_000 }],
        blocked: [{ storyId: 3, storyKey: 'AIK-3', title: 'Bad', reason: 'retry_limit' }],
        verification: [{ storyId: 4, storyKey: 'AIK-4', verificationRunId: 9, status: 'failed', checks: [{ checkKey: 'lint', status: 'failed', summary: '' }] }],
      }),
    }, T);
    const v = stationViews(s, R, T);
    expect(v.planner.state).toBe('completed');
    expect(v.implementer.state).toBe('error');
    expect(v.qa.state).toBe('error');
    expect(pmView(s, R).blocked[0]!.reason).toBe('retry_limit');
    expect(pmView(s, R).board.READY).toBe(2);
    expect(pmView(s, R).board.DONE).toBe(0);
    expect(Object.keys(pmView(s, R).board)).toEqual([...STORY_STATUS]);
    expect(pmView(s, R).doneToday).toBe(3);
  });

  test('developer overflow beyond 8', () => {
    let s = withRoom();
    for (let i = 1; i <= 10; i++) s = at(s, start(i, 'implementer', i, `AIK-${i}`), T);
    const v = stationViews(s, R, T).implementer;
    expect(v.seats).toHaveLength(8);
    expect(v.overflow).toBe(2);
    expect(v.stories).toHaveLength(10);
  });

  test('developer zone has at least 2 seats; other stations overflow beyond 2', () => {
    let s = at(withRoom(), start(1, 'implementer'), T);
    expect(stationViews(s, R, T).implementer.seats).toHaveLength(2);
    s = withRoom();
    for (let i = 1; i <= 3; i++) s = at(s, start(i, 'planner', i, `AIK-${i}`), T);
    const p = stationViews(s, R, T).planner;
    expect(p.seats).toHaveLength(2);
    expect(p.overflow).toBe(1);
  });
});
