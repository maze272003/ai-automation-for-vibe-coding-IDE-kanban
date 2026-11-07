import type { FURNITURE_KINDS, FurnitureItem } from '@aik/contracts';
import { SPECIAL_KINDS } from '@aik/contracts';
import { defaultRoomLayout, snapToGrid, validateLayout } from '../layout/room.ts';

export type EditorState = {
  roomId: number;
  items: FurnitureItem[];
  selectedId: string | null;
  dirty: boolean;
  lastError: string | null;
};

export type EditorAction =
  | { type: 'move'; id: string; x: number; z: number }
  | { type: 'rotate'; id: string; step: 15 | 90 }
  | { type: 'add'; kind: (typeof FURNITURE_KINDS)[number]; area: 'dev' | 'lab'; x: number; z: number }
  | { type: 'delete'; id: string }
  | { type: 'reset' }
  | { type: 'select'; id: string | null };

export function initialEditorState(roomId: number, items: FurnitureItem[]): EditorState {
  return { roomId, items, selectedId: null, dirty: false, lastError: null };
}

const SPECIAL = new Set<string>(SPECIAL_KINDS);

/** Accept `next` only when it is a valid layout; otherwise keep the old items and report why. */
function apply(s: EditorState, next: FurnitureItem[], selectedId: string | null = s.selectedId): EditorState {
  const before = new Set(validateLayout(s.items).errors);
  const { ok, errors } = validateLayout(next);
  if (!ok) {
    const fresh = errors.filter((e) => !before.has(e));
    return { ...s, lastError: (fresh.length > 0 ? fresh : errors).join('; ') };
  }
  return { ...s, items: next, selectedId, dirty: true, lastError: null };
}

function nextId(items: FurnitureItem[], kind: string): string {
  const ids = new Set(items.map((i) => i.id));
  let n = 1;
  while (ids.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

export function editorReduce(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'select':
      return { ...s, selectedId: a.id, lastError: null };
    case 'reset':
      return { ...s, items: defaultRoomLayout(), selectedId: null, dirty: true, lastError: null };
    case 'move': {
      if (!s.items.some((i) => i.id === a.id)) return s;
      const x = snapToGrid(a.x);
      const z = snapToGrid(a.z);
      return apply(s, s.items.map((i) => (i.id === a.id ? { ...i, x, z } : i)));
    }
    case 'rotate': {
      if (!s.items.some((i) => i.id === a.id)) return s;
      return apply(s, s.items.map((i) => (i.id === a.id ? { ...i, rotationY: (i.rotationY + a.step) % 360 } : i)));
    }
    case 'add': {
      const item: FurnitureItem = { id: nextId(s.items, a.kind), kind: a.kind, area: a.area, x: snapToGrid(a.x), z: snapToGrid(a.z), rotationY: 0 };
      return apply(s, [...s.items, item], item.id);
    }
    case 'delete': {
      const target = s.items.find((i) => i.id === a.id);
      if (!target) return s;
      if (SPECIAL.has(target.kind)) return { ...s, lastError: 'This item can be moved but not removed' };
      return apply(s, s.items.filter((i) => i.id !== a.id), s.selectedId === a.id ? null : s.selectedId);
    }
  }
}
