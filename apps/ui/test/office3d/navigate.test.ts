import { describe, expect, it } from 'vitest';
import { emptyOfficeState } from '../../src/office3d/state/model.ts';
import { activeAgentCount, pmTarget, stationTarget } from '../../src/office3d/ui/navigate.ts';
import type { StationView } from '../../src/office3d/state/selectors.ts';

const view = (stories: StationView['stories']): StationView => ({ state: 'idle', seats: [], overflow: 0, stories });
const story = (storyId: number) => ({ storyId, storyKey: `K-${storyId}`, title: null, state: 'working' as const });

describe('stationTarget', () => {
  it('opens the terminal for a single story', () => {
    expect(stationTarget(view([story(7)]), 1)).toEqual({ kind: 'terminal', storyId: 7 });
  });
  it('offers a popover when several stories are present', () => {
    const stories = [story(1), story(2)];
    expect(stationTarget(view(stories), 1)).toEqual({ kind: 'popover', stories });
  });
  it('falls back to the board when empty', () => {
    expect(stationTarget(view([]), 1)).toEqual({ kind: 'board' });
  });
  it('pm always goes to the board', () => {
    expect(pmTarget(view([]), 1)).toEqual({ kind: 'board' });
  });
});

describe('activeAgentCount', () => {
  it('counts every run in the room, uncapped by seats', () => {
    const s = emptyOfficeState();
    for (let i = 1; i <= 10; i++) s.runs.set(i, { runId: i, storyId: i, storyKey: `K-${i}`, storyTitle: null, role: 'implementer', roomId: 1, startedAt: 0 });
    s.runs.set(99, { runId: 99, storyId: 99, storyKey: 'X-1', storyTitle: null, role: 'planner', roomId: 2, startedAt: 0 });
    expect(activeAgentCount(s, 1)).toBe(10);
    expect(activeAgentCount(s, 2)).toBe(1);
    expect(activeAgentCount(s, 3)).toBe(0);
  });
});
