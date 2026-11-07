import { STATION_ROLES, type OfficeRoomDTO, type StationRole } from '@aik/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { signText } from '../screens/data.ts';
import type { OfficeState } from '../state/model.ts';
import { roomAggregate, stationViews, type StationView } from '../state/selectors.ts';
import { api } from '../../lib/api.ts';
import { ConfirmAction } from './ConfirmAction.tsx';
import { RoomSettingsDialog } from './RoomSettingsDialog.tsx';
import { StationPopover } from './StationPopover.tsx';
import { activeAgentCount, pmTarget, stationTarget } from './navigate.ts';

const ROLE_LABEL: Record<StationRole, string> = { planner: 'Planner', implementer: 'Developers', reviewer: 'Reviewer', pm: 'PM', qa: 'QA lab' };

export function QuickJumpPanel({ state, now, onSelectRoom }: { state: OfficeState; now: number; onSelectRoom: (roomId: number) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [popover, setPopover] = useState<{ roomId: number; stories: StationView['stories'] } | null>(null);
  const [settingsRoomId, setSettingsRoomId] = useState<number | null>(null);
  const [deleteRoom, setDeleteRoom] = useState<OfficeRoomDTO | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { active, archived } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...state.rooms.values()].sort((a, b) => a.id - b.id);
    const match = (r: OfficeRoomDTO) => q === '' || `${r.projectKey} ${r.projectName}`.toLowerCase().includes(q);
    return { active: all.filter((r) => r.state === 'active' && match(r)), archived: all.filter((r) => r.state === 'archived' && match(r)) };
  }, [state.rooms, query]);

  const settingsRoom = settingsRoomId === null ? null : (state.rooms.get(settingsRoomId) ?? null);

  const goBoard = (room: OfficeRoomDTO, storyId?: number) => {
    if (room.projectId === null) return;
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: String(room.projectId) },
      search: storyId === undefined ? {} : { terminal: String(storyId) },
    });
  };

  const clickStation = (room: OfficeRoomDTO, role: StationRole, view: StationView) => {
    if (room.projectId === null) return;
    const target = role === 'pm' ? pmTarget(view, room.projectId) : stationTarget(view, room.projectId);
    if (target.kind === 'terminal') goBoard(room, target.storyId);
    else if (target.kind === 'popover') setPopover({ roomId: room.id, stories: target.stories });
    else goBoard(room);
  };

  return (
    <aside data-testid="office-quickjump" className="flex h-full w-80 shrink-0 flex-col gap-2 overflow-y-auto rounded-panel border border-glass-border bg-surface-2 p-3 text-sm">
      <input
        ref={input}
        type="search"
        aria-label="Search rooms"
        placeholder="Search rooms ( / )"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded border border-glass-border bg-surface px-2 py-1 text-sm"
      />
      <ul className="flex flex-col gap-2">
        {active.map((room) => {
          const views = stationViews(state, room.id, now);
          const agg = roomAggregate(state, room.id, now);
          return (
            <li key={room.id} data-testid={`office-room-${room.projectKey}`} className="rounded border border-glass-border p-2">
              <div className="flex items-start gap-1">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelectRoom(room.id)}>
                  <span className="block text-xs font-bold">{signText(room.customization, room.projectName)}</span>
                  <span className="block text-xs text-muted">
                    {room.projectKey} · {agg} · {activeAgentCount(state, room.id)} active
                  </span>
                </button>
                <button
                  type="button"
                  data-testid={`office-room-settings-${room.projectKey}`}
                  aria-label={`Room settings ${room.projectKey}`}
                  className="shrink-0 rounded px-1 text-sm text-muted hover:bg-glass/60 hover:text-foreground"
                  onClick={() => setSettingsRoomId(room.id)}
                >
                  {'⚙'}
                </button>
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {STATION_ROLES.map((role) => (
                  <li key={role}>
                    <button
                      type="button"
                      data-testid={`office-station-${room.projectKey}-${role}`}
                      className="flex w-full justify-between rounded px-1 text-xs hover:bg-glass/60"
                      onClick={() => clickStation(room, role, views[role])}
                    >
                      <span>{ROLE_LABEL[role]}</span>
                      <span className="text-muted">{views[role].state}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {popover?.roomId === room.id ? (
                <StationPopover
                  stories={popover.stories}
                  onPick={(id) => {
                    setPopover(null);
                    goBoard(room, id);
                  }}
                  onClose={() => setPopover(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {archived.length > 0 ? (
        <details data-testid="office-archived" className="text-xs">
          <summary className="cursor-pointer font-semibold text-muted">Archived ({archived.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {archived.map((room) => (
              <li key={room.id} data-testid={`office-archived-${room.projectKey}`} className="flex items-center justify-between gap-1 text-muted">
                <span className="min-w-0 truncate">{room.projectKey} · {room.projectName}</span>
                <button
                  type="button"
                  data-testid={`office-delete-${room.projectKey}`}
                  className="shrink-0 rounded px-1 text-xs hover:bg-glass/60 hover:text-foreground"
                  onClick={() => setDeleteRoom(room)}
                >
                  Delete permanently
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {deleteRoom ? (
        <ConfirmAction
          open
          title={`Delete room ${deleteRoom.projectKey} permanently`}
          message="This permanently deletes the room and its customization. Re-importing the repository will create a fresh room. Continue?"
          confirmLabel="Delete permanently"
          onConfirm={() => api.del(`/office/rooms/${deleteRoom.id}`).then(() => undefined)}
          onClose={() => setDeleteRoom(null)}
        />
      ) : null}
      {settingsRoom ? (
        <RoomSettingsDialog key={settingsRoom.id} room={settingsRoom} open onClose={() => setSettingsRoomId(null)} />
      ) : null}
    </aside>
  );
}
