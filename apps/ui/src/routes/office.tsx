import { DEFAULT_OFFICE_PREFERENCES, type OfficePreferences } from '@aik/contracts';
import { useEffect, useState } from 'react';
import { TopBar } from '../components/shell/top-bar.tsx';
import { RoomEditor } from '../office3d/editor/RoomEditor.tsx';
import { OfficeCanvas } from '../office3d/scene/OfficeCanvas.tsx';
import { useOffice } from '../office3d/state/use-office.ts';
import { QuickJumpPanel } from '../office3d/ui/QuickJumpPanel.tsx';
import { useCanvasStationClick } from '../office3d/ui/StationPopover.tsx';

/** The 3D office: the canvas on the left, the live room list on the right. */
export function OfficePage() {
  const { state, now, ready, error } = useOffice();
  const [selectedRoomId, setSelectedRoom] = useState<number | null>(null);
  const [editRoomId, setEditRoomId] = useState<number | null>(null);
  const editRoom = editRoomId === null ? null : (state.rooms.get(editRoomId) ?? null);
  const [prefs, setPrefs] = useState<OfficePreferences>(DEFAULT_OFFICE_PREFERENCES);
  const hasProjects = [...state.rooms.values()].some((r) => r.state === 'active');
  const station = useCanvasStationClick(state, now, setSelectedRoom);

  useEffect(() => {
    let alive = true;
    void window.api
      .getAppSettings()
      .then((s) => {
        if (alive && s.office3d) setPrefs(s.office3d);
      })
      .catch(() => {
        // Keep the defaults when settings cannot be read.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Office" subtitle="Every project has its own suite" />
      <div className="min-h-0 flex-1 p-4">
        {!ready ? (
          <p data-testid="office-loading" className="text-sm text-muted">
            {error ?? 'Loading…'}
          </p>
        ) : (
          <div className="flex h-full gap-4">
            <div className="min-w-0 flex-1">
              {hasProjects ? (
                <div data-testid="office-canvas" className="relative h-full w-full overflow-hidden rounded-panel border border-glass-border bg-surface-2">
                  <OfficeCanvas
                    state={state}
                    now={now}
                    prefs={prefs}
                    selectedRoomId={selectedRoomId}
                    onSelectRoom={setSelectedRoom}
                    onStationClick={station.onStationClick}
                  />
                  {station.popover}
                </div>
              ) : (
                <p data-testid="office-empty" className="rounded-panel border border-dashed border-glass-border bg-glass/40 p-6 text-sm text-muted">
                  Import a project to open its office suite.
                </p>
              )}
            </div>
            <QuickJumpPanel state={state} now={now} onSelectRoom={setSelectedRoom} onEditRoom={setEditRoomId} />
          </div>
        )}
      </div>
      {editRoom ? <RoomEditor key={editRoom.id} room={editRoom} onClose={() => setEditRoomId(null)} /> : null}
    </div>
  );
}
