import { describe, expect, it } from 'vitest';
import { pmTarget, stationTarget } from '../../src/office3d/ui/navigate.ts';
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
