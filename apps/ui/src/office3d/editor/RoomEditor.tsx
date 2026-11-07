import type { FURNITURE_KINDS, FurnitureItem, OfficeRoomDTO, RoomCustomization } from '@aik/contracts';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.ts';
import { DEV_LENGTH, LAB_LENGTH, SLOT_DEPTH } from '../layout/dimensions.ts';
import { rectOf } from '../layout/footprints.ts';
import { effectiveLayout, snapToGrid, validateLayout } from '../layout/room.ts';
import { editorReduce, initialEditorState } from './editor-state.ts';
import { ConfirmAction } from '../ui/ConfirmAction.tsx';
import { Palette, type EditorArea } from './Palette.tsx';

/** Top-down 2D SVG plan of one suite (metres); the lab sits to the right of the dev office. */
const LAB_OFFSET = DEV_LENGTH + 1;
const VIEW = { x: -0.5, y: -0.8, w: LAB_OFFSET + LAB_LENGTH + 1, h: SLOT_DEPTH + 1.3 };
const FILL: Record<string, string> = {
  station: '#6d5efc', 'reading-lounge': '#a78bfa', 'coffee-bar': '#b45309', huddle: '#0ea5e9', 'test-board': '#16a34a',
  'audit-whiteboard': '#16a34a', 'lab-couch': '#a78bfa', plant: '#22c55e', rug: '#64748b',
};
const labelOf = (i: FurnitureItem) => (i.kind === 'station' ? (i.role ?? 'station') : i.kind);

/** First grid spot (0.5 m steps) in the area where an item of this kind keeps the layout valid. */
function findFreeSpot(items: FurnitureItem[], kind: FurnitureItem['kind'], area: EditorArea): { x: number; z: number } | null {
  const len = area === 'dev' ? DEV_LENGTH : LAB_LENGTH;
  for (let z = 1; z <= SLOT_DEPTH - 1; z += 0.5) {
    for (let x = 1; x <= len - 1; x += 0.5) {
      const cand: FurnitureItem = { id: '__probe', kind, area, x, z, rotationY: 0 };
      if (validateLayout([...items, cand]).ok) return { x, z };
    }
  }
  return null;
}

type Drag = { id: string; x: number; z: number; dx: number; dz: number; ok: boolean };

export function RoomEditor({ room, onClose, onSaved }: { room: OfficeRoomDTO; onClose: () => void; onSaved?: () => void }) {
  const initial = useMemo(() => effectiveLayout(room.customization.layout), [room.customization.layout]);
  const [s, dispatch] = useReducer(editorReduce, undefined, () => initialEditorState(room.id, initial));
  const [area, setArea] = useState<EditorArea>('dev');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [noSpace, setNoSpace] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const svg = useRef<SVGSVGElement>(null);

  const toPlan = useCallback((e: { clientX: number; clientY: number }) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return { x: 0, z: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, z: p.y };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable || !s.selectedId) return;
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        dispatch({ type: 'rotate', id: s.selectedId, step: e.shiftKey ? 15 : 90 });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        dispatch({ type: 'delete', id: s.selectedId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.selectedId]);

  const onPointerDown = (e: ReactPointerEvent, item: FurnitureItem) => {
    e.stopPropagation();
    setNoSpace(false);
    dispatch({ type: 'select', id: item.id });
    const p = toPlan(e);
    const off = item.area === 'lab' ? LAB_OFFSET : 0;
    svg.current?.setPointerCapture(e.pointerId);
    setDrag({ id: item.id, x: item.x, z: item.z, dx: item.x + off - p.x, dz: item.z - p.z, ok: true });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const item = s.items.find((i) => i.id === drag.id);
    if (!item) return;
    const p = toPlan(e);
    const off = item.area === 'lab' ? LAB_OFFSET : 0;
    const x = snapToGrid(p.x + drag.dx - off);
    const z = snapToGrid(p.z + drag.dz);
    const ok = validateLayout(s.items.map((i) => (i.id === drag.id ? { ...i, x, z } : i))).ok;
    setDrag({ ...drag, x, z, ok });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const item = s.items.find((i) => i.id === drag.id);
    if (item && (drag.x !== item.x || drag.z !== item.z)) dispatch({ type: 'move', id: drag.id, x: drag.x, z: drag.z });
    setDrag(null);
  };

  const patch = async (layout: FurnitureItem[] | null) => {
    const customization: RoomCustomization = { ...room.customization, layout };
    setBusy(true);
    setSaveError(null);
    try {
      await api.patch(`/office/rooms/${room.id}`, { customization });
      onSaved?.();
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the layout');
    } finally {
      setBusy(false);
    }
  };

  const add = (kind: (typeof FURNITURE_KINDS)[number]) => {
    const spot = findFreeSpot(s.items, kind, area);
    setNoSpace(spot === null);
    if (spot) dispatch({ type: 'add', kind, area, ...spot });
  };

  const shown = s.items.map((i) => (drag && drag.id === i.id ? { ...i, x: drag.x, z: drag.z } : i));
  const selected = s.items.find((i) => i.id === s.selectedId) ?? null;
  const error = saveError ?? s.lastError ?? (noSpace ? 'No free space for that item in this area' : null);

  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(4_7_16/0.70)] backdrop-blur-[3px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="room-editor"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[95vh] w-[64rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-panel border border-glass-border bg-overlay-fill p-4 text-foreground shadow-panel backdrop-blur-[22px]"
        >
        <div className="flex items-center justify-between">
          <DialogPrimitive.Title className="text-base font-bold">Edit room: {room.projectKey}</DialogPrimitive.Title>
          <span className="text-xs text-muted">Drag to move. R rotates 90 degrees, Shift+R 15. Delete removes.</span>
        </div>
        <div className="flex min-h-0 gap-3">
          <svg
            ref={svg}
            data-testid="room-editor-plan"
            viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
            className="min-w-0 flex-1 touch-none select-none rounded-control border border-border bg-surface-2"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
            onPointerDown={() => dispatch({ type: 'select', id: null })}
          >
            {([['dev', 0, DEV_LENGTH], ['lab', LAB_OFFSET, LAB_LENGTH]] as const).map(([a, off, len]) => (
              <g key={a}>
                <rect x={off} y={0} width={len} height={SLOT_DEPTH} fill="none" stroke="currentColor" strokeWidth={0.08} opacity={0.5} />
                <text x={off + 0.2} y={-0.2} fontSize={0.45} fill="currentColor" opacity={0.7}>
                  {a === 'dev' ? 'Dev office (back wall at top)' : 'QA lab'}
                </text>
              </g>
            ))}
            {shown.map((i) => {
              const r = rectOf(i);
              if (!r) return null; // role-less station: nothing to draw (effectiveLayout keeps these out)
              const off = i.area === 'lab' ? LAB_OFFSET : 0;
              const bad = drag?.id === i.id && !drag.ok;
              return (
                <g
                  key={i.id}
                  data-testid={`editor-item-${i.id}`}
                  data-selected={s.selectedId === i.id}
                  onPointerDown={(e) => onPointerDown(e, i)}
                  style={{ cursor: 'grab' }}
                >
                  <rect
                    x={r.x0 + off}
                    y={r.z0}
                    width={r.x1 - r.x0}
                    height={r.z1 - r.z0}
                    fill={bad ? '#ef4444' : (FILL[i.kind] ?? '#94a3b8')}
                    fillOpacity={i.kind === 'rug' ? 0.35 : 0.8}
                    stroke={s.selectedId === i.id ? '#fff' : 'rgb(0 0 0 / 0.4)'}
                    strokeWidth={s.selectedId === i.id ? 0.1 : 0.04}
                  />
                  <text x={i.x + off} y={i.z} fontSize={0.38} textAnchor="middle" dominantBaseline="middle" fill="#fff" pointerEvents="none">
                    {labelOf(i)}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="flex w-52 shrink-0 flex-col gap-3">
            <Palette area={area} onArea={setArea} onAdd={add} />
            <div className="text-xs text-muted" data-testid="editor-selection">
              {selected ? `${labelOf(selected)} at ${selected.x}, ${selected.z} (${selected.rotationY} deg)` : 'Nothing selected'}
            </div>
            <div className="flex gap-1">
              <Button disabled={!selected} data-testid="editor-rotate" onClick={() => selected && dispatch({ type: 'rotate', id: selected.id, step: 90 })}>
                Rotate
              </Button>
              <Button disabled={!selected} data-testid="editor-delete" onClick={() => selected && dispatch({ type: 'delete', id: selected.id })}>
                Delete
              </Button>
            </div>
          </div>
        </div>
        <p role="alert" data-testid="editor-error" className="min-h-5 text-sm text-danger-foreground">
          {error ?? ''}
        </p>
        <div className="flex items-center justify-between">
          <Button
            variant="danger"
            data-testid="room-editor-reset"
            disabled={busy}
            onClick={() => setConfirmReset(true)}
          >
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button data-testid="room-editor-cancel" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" data-testid="room-editor-save" disabled={busy || !s.dirty} onClick={() => void patch(s.items)}>
              Save
            </Button>
          </div>
        </div>
        {confirmReset ? (
          <ConfirmAction
            open
            title="Reset room layout"
            message="This discards your custom furniture layout and restores the default. Continue?"
            confirmLabel="Reset to default"
            onConfirm={async () => {
              await api.patch(`/office/rooms/${room.id}`, { customization: { ...room.customization, layout: null } });
              onSaved?.();
              onClose();
            }}
            onClose={() => setConfirmReset(false)}
          />
        ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
