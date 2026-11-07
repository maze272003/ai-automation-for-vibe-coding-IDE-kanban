import type { FURNITURE_KINDS, FurnitureItem, OfficeRoomDTO, RoomCustomization } from '@aik/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { api } from '../../lib/api.ts';
import { DEV_LENGTH, LAB_LENGTH, SLOT_DEPTH } from '../layout/dimensions.ts';
import { rectOf } from '../layout/footprints.ts';
import { defaultRoomLayout, snapToGrid, validateLayout } from '../layout/room.ts';
import { editorReduce, initialEditorState } from './editor-state.ts';
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
  const initial = useMemo(() => room.customization.layout ?? defaultRoomLayout(), [room.customization.layout]);
  const [s, dispatch] = useReducer(editorReduce, undefined, () => initialEditorState(room.id, initial));
  const [area, setArea] = useState<EditorArea>('dev');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [noSpace, setNoSpace] = useState(false);
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
    <div
      role="dialog"
      aria-label={`Edit room: ${room.projectKey}`}
      data-testid="room-editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(4_7_16/0.70)] p-4 backdrop-blur-[3px]"
    >
      <div className="flex max-h-full w-full max-w-5xl flex-col gap-3 rounded-panel border border-glass-border bg-overlay-fill p-4 text-foreground shadow-panel">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">Edit room: {room.projectKey}</h2>
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
              const r = rectOf(i)!;
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
            onClick={() => {
              dispatch({ type: 'reset' });
              void patch(null);
            }}
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
      </div>
    </div>
  );
}
