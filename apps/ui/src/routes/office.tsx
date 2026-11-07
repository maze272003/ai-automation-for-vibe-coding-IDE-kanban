import { DEFAULT_OFFICE_PREFERENCES, type OfficePreferences } from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';
import { isModalOpen } from '../lib/shortcuts.ts';
import { officeKeyAction } from '../office3d/scene/camera/keys.ts';
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
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [walking, setWalking] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const hasProjects = [...state.rooms.values()].some((r) => r.state === 'active');
  const station = useCanvasStationClick(state, now, setSelectedRoom);

  useEffect(() => {
    let alive = true;
    void window.api
      .getAppSettings()
      .then((s) => {
        if (!alive) return;
        if (s.office3d) setPrefs(s.office3d);
        setPrefsLoaded(true);
      })
      .catch(() => {
        // Keep the defaults when settings cannot be read.
        if (alive) setPrefsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Default view on open (spec 6.7), applied once when both the preferences and the office state are in.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !prefsLoaded || !ready) return;
    appliedDefault.current = true;
    if (prefs.defaultView === 'last-room' && prefs.lastRoomId !== null && state.rooms.get(prefs.lastRoomId)?.state === 'active') {
      setSelectedRoom(prefs.lastRoomId);
    } else if (prefs.defaultView === 'walk' && prefs.walkEnabled) setWalking(true);
  }, [prefsLoaded, ready, prefs, state.rooms]);

  // Remember the last selected room (debounced 1 s); merged into the stored office prefs.
  const savedRoomId = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!prefsLoaded || selectedRoomId === null) return;
    if (savedRoomId.current === undefined) savedRoomId.current = prefs.lastRoomId;
    if (selectedRoomId === savedRoomId.current) return;
    const timer = setTimeout(() => {
      void window.api
        .getAppSettings()
        .then((settings) => {
          const lastRoomId = selectedRoomId;
          savedRoomId.current = lastRoomId;
          return window.api.setAppSettings({ ...settings, office3d: { ...(settings.office3d ?? prefs), lastRoomId } });
        })
        .catch(() => {
          // Best effort: the last room is a convenience.
        });
    }, 1000);
    return () => clearTimeout(timer);
  }, [selectedRoomId, prefsLoaded, prefs]);

  // Office keys from the shortcuts registry: V toggles walk mode, Esc returns to the overview.
  useEffect(() => {
    if (!hasProjects) return;
    const onKey = (e: KeyboardEvent) => {
      const action = officeKeyAction(e, { walkEnabled: prefs.walkEnabled, modalOpen: isModalOpen() });
      if (action === 'walk') {
        e.preventDefault();
        setWalking((w) => !w);
      } else if (action === 'back') {
        setWalking(false);
        setSelectedRoom(null);
        setResetToken((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasProjects, prefs.walkEnabled]);

  const exitWalk = () => {
    setWalking(false);
    setSelectedRoom(null);
    setResetToken((n) => n + 1);
  };

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
                    onOpenBoard={station.onOpenBoard}
                    walking={walking}
                    resetToken={resetToken}
                    onExitWalk={exitWalk}
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
