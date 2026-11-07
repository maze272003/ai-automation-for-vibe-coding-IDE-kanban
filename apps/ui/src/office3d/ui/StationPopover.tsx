import type { StationRole } from '@aik/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import type { OfficeState } from '../state/model.ts';
import { stationViews, type StationView } from '../state/selectors.ts';
import { pmTarget, stationTarget } from './navigate.ts';

/** Lists the stories at a station so the user can pick which terminal to open. */
export function StationPopover({ stories, onPick, onClose, title, className = 'mt-1' }: {
  stories: StationView['stories'];
  onPick: (storyId: number) => void;
  onClose: () => void;
  /** Heading shown when the popover floats over the 3D view (which room and station it belongs to). */
  title?: string;
  className?: string;
}) {
  return (
    <div role="dialog" aria-label="Pick a story" data-testid="office-station-popover" className={`${className} rounded-panel border border-glass-border bg-surface-2 p-2 text-xs shadow-lg`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <ul className="flex flex-col gap-1">
        {stories.map((s) => (
          <li key={s.storyId}>
            <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-glass/60" onClick={() => onPick(s.storyId)}>
              <span className="font-semibold">{s.storyKey}</span> <span className="text-muted">{s.state}</span>
              {s.title ? <span className="block truncate text-muted">{s.title}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-1 text-muted underline" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

const ROLE_NAME: Record<StationRole, string> = { planner: 'Planner', implementer: 'Developers', reviewer: 'Reviewer', pm: 'PM', qa: 'QA lab' };

/**
 * Station clicks from the 3D view (status rings, agent figures): one story opens its terminal, several open a
 * popover floating over the canvas (place `popover` inside a `relative` container), none opens the board.
 */
export function useCanvasStationClick(state: OfficeState, now: number, onSelectRoom: (roomId: number) => void): {
  onStationClick: (roomId: number, role: StationRole) => void;
  /** Kanban wall screen / PM desk: straight to the room's project board. */
  onOpenBoard: (roomId: number) => void;
  popover: ReactNode;
} {
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ roomId: number; role: StationRole; stories: StationView['stories'] } | null>(null);
  const goBoard = (roomId: number, storyId?: number) => {
    const room = state.rooms.get(roomId);
    if (!room || room.projectId === null) return;
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: String(room.projectId) },
      search: storyId === undefined ? {} : { terminal: String(storyId) },
    });
  };
  const onStationClick = (roomId: number, role: StationRole) => {
    const room = state.rooms.get(roomId);
    onSelectRoom(roomId);
    if (!room || room.projectId === null) return;
    const view = stationViews(state, roomId, now)[role];
    const target = role === 'pm' ? pmTarget(view, room.projectId) : stationTarget(view, room.projectId);
    if (target.kind === 'terminal') goBoard(roomId, target.storyId);
    else if (target.kind === 'popover') setOpen({ roomId, role, stories: target.stories });
    else goBoard(roomId);
  };
  const onOpenBoard = (roomId: number) => {
    onSelectRoom(roomId);
    goBoard(roomId);
  };
  const room = open ? state.rooms.get(open.roomId) : undefined;
  const popover =
    open && room ? (
      <div className="absolute left-3 top-3 z-10 w-64">
        <StationPopover
          className=""
          title={`${room.projectKey} · ${ROLE_NAME[open.role]}`}
          stories={open.stories}
          onPick={(id) => {
            setOpen(null);
            goBoard(open.roomId, id);
          }}
          onClose={() => setOpen(null)}
        />
      </div>
    ) : null;
  return { onStationClick, onOpenBoard, popover };
}
