import { ROOM_ICONS, type OfficeRoomDTO, type RoomCustomization, type ScreenToggles } from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Dialog } from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { ROOM_ICON_GRIDS, type RoomIcon } from './icons.ts';

const SCREEN_LABEL: Record<keyof ScreenToggles, string> = { kanban: 'Kanban wall', activity: 'Activity monitor', runs: 'Runs monitor' };
const SCREEN_KEYS = ['kanban', 'activity', 'runs'] as const;

function IconPreview({ icon, color }: { icon: RoomIcon; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 8, 8);
    ctx.fillStyle = color;
    ROOM_ICON_GRIDS[icon].forEach((row, y) => {
      for (let x = 0; x < 8; x++) if (row[x] === '#') ctx.fillRect(x, y, 1, 1);
    });
  }, [icon, color]);
  return <canvas ref={ref} width={8} height={8} aria-hidden="true" className="h-8 w-8 [image-rendering:pixelated]" />;
}

export function RoomSettingsDialog({
  room, open, onClose, onSaved, onEditRoom,
}: {
  room: OfficeRoomDTO;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** Task 20 wires the layout editor; the button only shows when a handler is given. */
  onEditRoom?: () => void;
}) {
  const c = room.customization;
  const [signName, setSignName] = useState(c.signName ?? '');
  const [accent, setAccent] = useState(c.accentColor);
  const [icon, setIcon] = useState<RoomIcon | null>(c.icon);
  const [custom, setCustom] = useState(c.screens !== null);
  const [screens, setScreens] = useState<ScreenToggles>(c.screens ?? { kanban: true, activity: true, runs: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const customization: RoomCustomization = {
      ...c,
      signName: signName.trim() === '' ? null : signName.trim(),
      accentColor: accent,
      icon,
      screens: custom ? screens : null,
    };
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/office/rooms/${room.id}`, { customization });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save room settings');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={`Room settings: ${room.projectKey}`} onClose={onClose}>
      <div data-testid="room-settings" className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Sign name</span>
          <Input
            data-testid="room-sign-name"
            aria-label="Sign name"
            maxLength={60}
            placeholder={`${room.projectName} Development Office`}
            value={signName}
            onChange={(e) => setSignName(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">Accent colour</span>
          <input data-testid="room-accent" type="color" aria-label="Accent colour" value={accent} onChange={(e) => setAccent(e.target.value)} />
        </label>
        <fieldset>
          <legend className="text-muted">Icon</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            <label className={cn('flex h-10 min-w-10 cursor-pointer items-center justify-center rounded border px-1 text-xs', icon === null ? 'border-accent' : 'border-border')}>
              <input type="radio" name="room-icon" value="" aria-label="No icon" checked={icon === null} onChange={() => setIcon(null)} className="sr-only" />
              None
            </label>
            {ROOM_ICONS.map((name) => (
              <label key={name} className={cn('flex h-10 w-10 cursor-pointer items-center justify-center rounded border', icon === name ? 'border-accent bg-accent/10' : 'border-border')}>
                <input type="radio" name="room-icon" value={name} aria-label={`Icon ${name}`} checked={icon === name} onChange={() => setIcon(name)} className="sr-only" />
                <IconPreview icon={name} color={accent} />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-muted">Screens</legend>
          <div className="mt-1 flex gap-4">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="room-screens" aria-label="Inherit screens" checked={!custom} onChange={() => setCustom(false)} />
              Inherit global default
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="room-screens" aria-label="Custom screens" checked={custom} onChange={() => setCustom(true)} />
              Custom
            </label>
          </div>
          <div className="mt-1 flex flex-col gap-1 pl-1">
            {SCREEN_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label={SCREEN_LABEL[k]}
                  disabled={!custom}
                  checked={screens[k]}
                  onChange={(e) => setScreens({ ...screens, [k]: e.target.checked })}
                />
                {SCREEN_LABEL[k]}
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <p role="alert" className="text-xs text-danger-foreground">{error}</p> : null}
        <div className="flex justify-between gap-2">
          <div>{onEditRoom ? <Button data-testid="room-edit-layout" onClick={onEditRoom}>Edit room</Button> : null}</div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="room-settings-save" disabled={busy} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
