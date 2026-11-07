import type { FurnitureItem } from '@aik/contracts';
import { placeItem, placeParts, WORLD_FRAME, type Placement } from './place.ts';
import type { Part } from './props.ts';
import { COLORS, meetingRoom, type Structure } from './structure.ts';

/**
 * Hub interior (spec §6.2), authored in world coordinates (hub = -18..18 on both axes). The four exit
 * corridors (|x| < 2.5 toward N/S, |z| < 2.5 toward E/W) are kept clear.
 * - NW / NE corners: two glass meeting rooms.
 * - North-west: the AI Ops monitoring center (screen wall + consoles).
 * - North-east: lounge with coffee bar.
 * - South-west: lobby seating. South-east: reception desk (entrance side).
 */
const it = (id: string, kind: FurnitureItem['kind'], x: number, z: number, rotationY = 0, role?: FurnitureItem['role']): FurnitureItem => ({
  id, kind, area: 'dev', x, z, rotationY, ...(role ? { role } : {}),
});

const HUB_ITEMS: FurnitureItem[] = [
  // Meeting rooms.
  it('meet-a', 'huddle', -13.75, -14.25),
  it('meet-a-plant', 'plant', -16.8, -16.8),
  it('meet-b', 'huddle', 13.75, -14.25),
  it('meet-b-plant', 'plant', 16.8, -16.8),
  // AI Ops consoles facing the screen wall.
  it('ops-1', 'station', -13, -5.2, 0, 'reviewer'),
  it('ops-2', 'station', -10, -5.2, 0, 'reviewer'),
  it('ops-3', 'station', -7, -5.2, 0, 'reviewer'),
  // Lounge.
  it('lounge', 'reading-lounge', 12, -6.2, 180),
  it('lounge-coffee', 'coffee-bar', 7.2, -9.2, 180),
  it('lounge-plant', 'plant', 16.6, -8.8),
  it('lounge-shelf', 'bookshelf', 16.8, -5, 270),
  // Lobby seating.
  it('lobby-rug', 'rug', -11, 9),
  it('lobby-sofa-1', 'sofa', -11, 7.2, 0),
  it('lobby-sofa-2', 'sofa', -11, 10.8, 180),
  it('lobby-table', 'huddle-table', -11, 9),
  it('lobby-plant-1', 'plant', -16.6, 16.6),
  it('lobby-plant-2', 'plant', -5, 16.6),
  it('lobby-lamp', 'lamp', -14, 9),
  // Entrance plants.
  it('entrance-plant-1', 'plant', 4, 16.6),
  it('entrance-plant-2', 'plant', 16.6, 16.6),
];

/** Reception desk: two counters with the receptionist side to the north, visitors arrive from the south. */
const RECEPTION_PARTS: Part[] = [
  { model: 'counter', x: -1, y: 0, z: 0, rot: 180, scale: [1, 1, 1] },
  { model: 'counter', x: 1, y: 0, z: 0, rot: 180, scale: [1, 1, 1] },
  { model: 'monitor', x: -0.8, y: 1, z: -0.1, rot: 180, scale: [1, 1, 1] },
  { model: 'monitor', x: 1.2, y: 1, z: -0.1, rot: 180, scale: [1, 1, 1] },
  { model: 'chair', x: -0.8, y: 0, z: -0.9, rot: 0, scale: [1, 1, 1] },
  { model: 'chair', x: 1.2, y: 0, z: -0.9, rot: 0, scale: [1, 1, 1] },
  { model: 'plant', x: 2.5, y: 0, z: 0, rot: 0, scale: [1, 1, 1] },
];
const RECEPTION = { area: 'dev' as const, x: 10, z: 8, rotationY: 0 };

/** The AI Ops screen wall (centre, size; faces +z). */
export const OPS_WALL = { x: -10, y: 1.75, z: -7.88, w: 10, h: 2.5 } as const;
/** The reception sign above the desk (faces +z, toward the entrance). */
export const RECEPTION_SIGN = { x: 10, y: 2.9, z: 8.6, w: 4, h: 0.5 } as const;

export function hubPlacements(low: boolean): Placement[] {
  const o = { low, accent: '#38bdf8', dim: false };
  return [
    ...HUB_ITEMS.flatMap((i) => placeItem(WORLD_FRAME, i, 1, o)),
    ...placeParts(WORLD_FRAME, RECEPTION, RECEPTION_PARTS, o),
  ];
}

export function hubStructure(s: Structure): void {
  meetingRoom(s, { x0: -17.85, z0: -17.85, x1: -9.5, z1: -10.5 }, 'z1');
  meetingRoom(s, { x0: 9.5, z0: -17.85, x1: 17.85, z1: -10.5 }, 'z1');
  // Backing panel of the AI Ops screen wall.
  s.solid.push({ x0: OPS_WALL.x - OPS_WALL.w / 2 - 0.2, x1: OPS_WALL.x + OPS_WALL.w / 2 + 0.2, z0: OPS_WALL.z - 0.25, z1: OPS_WALL.z - 0.03, y0: 0, y1: 3.2, color: COLORS.wallDark });
}
