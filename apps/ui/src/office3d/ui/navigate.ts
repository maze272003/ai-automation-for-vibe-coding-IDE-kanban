import type { StationView } from '../state/selectors.ts';

export type StationTarget =
  | { kind: 'terminal'; storyId: number }
  | { kind: 'popover'; stories: StationView['stories'] }
  | { kind: 'board' };

/** Where a click on a station should lead. The target is project-relative; callers add the project. */
export function stationTarget(view: StationView, _projectId: number): StationTarget {
  if (view.stories.length === 1) return { kind: 'terminal', storyId: view.stories[0]!.storyId };
  if (view.stories.length > 1) return { kind: 'popover', stories: view.stories };
  return { kind: 'board' };
}

/** The board has no BLOCKED filter today, so the PM desk simply opens the board. */
export function pmTarget(_pm: unknown, _projectId: number): { kind: 'board' } {
  return { kind: 'board' };
}
