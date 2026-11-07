import type { FurnitureItem, StationRole } from '@aik/contracts';
import { STATION_ROLES } from '@aik/contracts';
import { DEV_LENGTH, DOOR_WIDTH, GRID, LAB_LENGTH, SLOT_DEPTH } from './dimensions.ts';
import { devZoneSeats, rectOf } from './footprints.ts';
import { intersects, type Rect } from './geometry.ts';
import { buildWaypointGraph, isConnected } from './waypoints.ts';

export { devZoneSeats };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Seats at a non-developer station: 1, or 2 when two runs of that role are active; beyond that is overflow ("+N"). */
export function stationSeats(activeRuns: number): { seats: number; overflow: number } {
  return { seats: clamp(activeRuns, 1, 2), overflow: Math.max(0, activeRuns - 2) };
}

/** Snap a coordinate to the 0.25 m editor grid. */
export function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

const st = (role: StationRole, area: 'dev' | 'lab', x: number, z: number): FurnitureItem => ({
  id: `station-${role}`,
  kind: 'station',
  area,
  x,
  z,
  rotationY: 0,
  role,
});
const it = (id: string, kind: FurnitureItem['kind'], area: 'dev' | 'lab', x: number, z: number, rotationY = 0): FurnitureItem => ({
  id,
  kind,
  area,
  x,
  z,
  rotationY,
});

/**
 * Default suite layout (spec 6.4 / 6.4a), room-local coordinates: dev x 0..14, lab x 0..8, z 0..12
 * (z=0 back wall, z=12 glass front). Pipeline row planner -> developer zone -> reviewer -> pm.
 */
export function defaultRoomLayout(): FurnitureItem[] {
  return [
    st('planner', 'dev', 1.2, 3.5),
    st('implementer', 'dev', 4.4, 5),
    st('reviewer', 'dev', 9, 3.5),
    st('pm', 'dev', 11.6, 3.5),
    it('lounge', 'reading-lounge', 'dev', 2.2, 10.5),
    it('huddle', 'huddle', 'dev', 9.2, 9.6),
    it('coffee', 'coffee-bar', 'dev', 12.2, 11.5),
    st('qa', 'lab', 4, 2.8),
    it('test-board', 'test-board', 'lab', 4, 0.2),
    it('audit', 'audit-whiteboard', 'lab', 7.6, 6, 270),
    it('couch', 'lab-couch', 'lab', 1.6, 10.8),
    it('lab-plant', 'plant', 'lab', 7.4, 11.4),
  ];
}

const AREA_LENGTH = { dev: DEV_LENGTH, lab: LAB_LENGTH } as const;
const EPS = 1e-6;
const SWING_DEPTH = 1.2;
const INTERNAL_DOOR_Z = 5.7;
const WALKWAY: Rect = { x0: DEV_LENGTH / 2 - 0.5, z0: 0, x1: DEV_LENGTH / 2 + 0.5, z1: SLOT_DEPTH };

function doorSwings(): Array<{ name: string; area: 'dev' | 'lab'; rect: Rect }> {
  const h = DOOR_WIDTH / 2;
  return [
    { name: 'dev door', area: 'dev', rect: { x0: DEV_LENGTH / 2 - h, z0: SLOT_DEPTH - SWING_DEPTH, x1: DEV_LENGTH / 2 + h, z1: SLOT_DEPTH } },
    { name: 'lab door', area: 'lab', rect: { x0: LAB_LENGTH / 2 - h, z0: SLOT_DEPTH - SWING_DEPTH, x1: LAB_LENGTH / 2 + h, z1: SLOT_DEPTH } },
    { name: 'internal door (dev side)', area: 'dev', rect: { x0: DEV_LENGTH - SWING_DEPTH, z0: INTERNAL_DOOR_Z - h, x1: DEV_LENGTH, z1: INTERNAL_DOOR_Z + h } },
    { name: 'internal door (lab side)', area: 'lab', rect: { x0: 0, z0: INTERNAL_DOOR_Z - h, x1: SWING_DEPTH, z1: INTERNAL_DOOR_Z + h } },
  ];
}

/** Editor validation: bounds, overlaps, door swings, walkway, required special items, reachability. */
export function validateLayout(items: FurnitureItem[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const placed: Array<{ item: FurnitureItem; rect: Rect }> = [];

  for (const i of items) {
    const rect = rectOf(i);
    if (!rect) {
      errors.push(`${i.id}: station has no role`);
      continue;
    }
    const len = AREA_LENGTH[i.area];
    if (rect.x0 < -EPS || rect.z0 < -EPS || rect.x1 > len + EPS || rect.z1 > SLOT_DEPTH + EPS) {
      errors.push(`${i.id}: outside the ${i.area} room or crossing a wall`);
    }
    placed.push({ item: i, rect });
  }

  // Rugs are floor decoration: walkable, and allowed to sit under other items.
  const solid = placed.filter((p) => p.item.kind !== 'rug');

  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      const pa = solid[a]!;
      const pb = solid[b]!;
      if (pa.item.area === pb.item.area && intersects(pa.rect, pb.rect)) {
        errors.push(`${pa.item.id} overlaps ${pb.item.id}`);
      }
    }
  }

  const swings = doorSwings();
  for (const p of solid) {
    for (const sw of swings) {
      if (sw.area === p.item.area && intersects(p.rect, sw.rect)) errors.push(`${p.item.id}: blocks the swing of the ${sw.name}`);
    }
    if (p.item.area === 'dev' && intersects(p.rect, WALKWAY)) {
      errors.push(`${p.item.id}: blocks the walkway from the door to the back wall`);
    }
  }

  const counts = new Map<string, number>();
  for (const i of items) {
    const key = i.kind === 'station' ? (i.role ? `station:${i.role}` : null) : i.kind;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const required = [
    ...STATION_ROLES.map((r) => `station:${r}`),
    'reading-lounge',
    'coffee-bar',
    'huddle',
    'test-board',
    'audit-whiteboard',
    'lab-couch',
  ];
  for (const key of required) {
    const n = counts.get(key) ?? 0;
    if (n === 0) errors.push(`missing required item: ${key}`);
    else if (n > 1) errors.push(`duplicate item: ${key} (${n}, expected exactly 1)`);
  }

  if (errors.length === 0 && !isConnected(buildWaypointGraph(items))) {
    errors.push('unreachable: some activity spots cannot be reached from the door');
  }
  return { ok: errors.length === 0, errors };
}

const effectiveCache = new WeakMap<FurnitureItem[], FurnitureItem[]>();

/**
 * The layout to draw/edit for a stored customization: the stored one when it passes validateLayout,
 * otherwise the default (null, or a semantically invalid layout written by an API client). Memoized
 * per stored array, since room DTOs keep their layout reference until the next refetch.
 */
export function effectiveLayout(stored: FurnitureItem[] | null): FurnitureItem[] {
  if (stored === null) return defaultRoomLayout();
  let out = effectiveCache.get(stored);
  if (!out) {
    out = validateLayout(stored).ok ? stored : defaultRoomLayout();
    effectiveCache.set(stored, out);
  }
  return out;
}
