import type { FurnitureItem, StationRole } from '@aik/contracts';
import { FOOTPRINTS } from '../layout/footprints.ts';
import { devZoneSeats } from '../layout/room.ts';
import type { VOXEL_MODELS } from '../voxel/models.ts';

export type ModelName = keyof typeof VOXEL_MODELS;

/**
 * One voxel model placed inside an item, in item-local space (see transform.ts): x/z offsets from the item
 * centre, y = height of the model base, `rot` degrees around y (added to the item rotation). Models are
 * centred on x/z with their base at y = 0 (VoxelInstances re-centres the meshed geometry).
 */
export type Part = {
  model: ModelName;
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: [number, number, number];
  /** Multiply by the room accent colour (identity: chair fabric). */
  accent?: boolean;
  /** Small decoration dropped at Low quality ("simplified furniture", spec §9). */
  detail?: boolean;
};

/** A pixel screen mounted on an item (item-local centre, size in metres; faces item-local +z). */
export type ScreenMount = { kind: 'pm' | 'test-board'; x: number; y: number; z: number; w: number; h: number };

const DESK_TOP = 0.75;
const ONE: [number, number, number] = [1, 1, 1];
const p = (model: ModelName, x: number, y: number, z: number, rot = 0, scale = ONE, extra: Partial<Part> = {}): Part => ({
  model, x, y, z, rot, scale, ...extra,
});

/**
 * A workstation for one sitter at (x, zSeat): the sitter faces item-local -z (toward the desk and the back
 * wall at rotationY 0), the chair back is on +z.
 */
function workstation(x: number, zSeat: number, deskScaleX = 1): Part[] {
  const deskZ = zSeat - 0.6;
  return [
    p('desk', x, 0, deskZ, 0, [deskScaleX, 1, 1]),
    p('monitor', x, DESK_TOP, deskZ - 0.2),
    p('keyboard', x, DESK_TOP, deskZ + 0.15, 0, ONE, { detail: true }),
    p('chair', x, 0, zSeat + 0.1, 180, ONE, { accent: true }),
  ];
}

/** Seat (chair) offsets of a station, item-local; matches the seat order of `stationViews`. */
export function stationSeatOffsets(role: StationRole, seats: number): Array<{ x: number; z: number }> {
  if (role === 'implementer') {
    const n = devZoneSeats(seats).seats;
    const d = FOOTPRINTS['station:implementer'].d;
    return Array.from({ length: n }, (_, k) => ({ x: k % 2 === 0 ? -1 : 1, z: -d / 2 + 1 + Math.floor(k / 2) * 2 + 0.1 }));
  }
  const n = Math.min(2, Math.max(1, seats));
  return Array.from({ length: n }, (_, k) => ({ x: (k - (n - 1) / 2) * 1.2, z: 0.55 + 0.1 }));
}

/** Voxel parts that make up a layout item. `seats` = seats shown at a station (from `stationViews`). */
export function itemParts(item: FurnitureItem, seats = 1): Part[] {
  switch (item.kind) {
    case 'station': {
      if (!item.role) return [];
      if (item.role === 'implementer') {
        return stationSeatOffsets('implementer', seats).flatMap((s) => workstation(s.x, s.z - 0.1));
      }
      const offs = stationSeatOffsets(item.role, seats);
      if (offs.length === 1) return workstation(0, 0.55);
      // Two sitters share one long desk.
      return [
        p('desk', 0, 0, -0.05, 0, [1.6, 1, 1]),
        ...offs.flatMap((s) => [
          p('monitor', s.x, DESK_TOP, -0.25),
          p('keyboard', s.x, DESK_TOP, 0.1, 0, ONE, { detail: true }),
          p('chair', s.x, 0, 0.65, 180, ONE, { accent: true }),
        ]),
      ];
    }
    case 'reading-lounge':
      return [
        p('rug', 0, 0, -0.35, 0, [1, 0.2, 1]),
        p('sofa', 0, 0, 0.3, 180, [1.4, 1, 1]),
        p('stool', 1.75, 0, 0.35, 0, ONE, { detail: true }),
        p('mug', 1.75, 0.75, 0.35, 0, [0.5, 0.5, 0.5], { detail: true }),
        p('lamp', -1.75, 0, 0.5),
      ];
    case 'coffee-bar':
      return [
        p('counter', -0.6, 0, 0.05, 180),
        p('coffee-machine', -1.15, 1, 0.1, 180),
        p('mug', -0.35, 1, -0.1, 0, [0.5, 0.5, 0.5], { detail: true }),
        p('mug', -0.05, 1, 0.05, 0, [0.5, 0.5, 0.5], { detail: true }),
        p('counter', 1.1, 0, 0.05, 180, [0.7, 1, 1]),
      ];
    case 'huddle':
      return [
        p('huddle-table', 0, 0, 0),
        ...([[-0.6, -0.85], [0.6, -0.85], [-0.6, 0.85], [0.6, 0.85]] as const).map(([x, z]) => p('stool', x, 0, z)),
      ];
    case 'test-board':
      return [p('test-board-frame', 0, 0.85, -0.02, 0, [2.6, 1.15, 1])];
    case 'audit-whiteboard':
      return [p('whiteboard', 0, 0, -0.15, 0, [1.3, 1.2, 1])];
    case 'lab-couch':
      return [p('sofa', 0, 0, 0.1, 180, [1.3, 1, 1.1])];
    case 'desk':
      return [p('desk', 0, 0, 0, 0, [1.33, 1, 1.33])];
    case 'chair':
      return [p('chair', 0, 0, 0, 0, ONE, { accent: true })];
    case 'sofa':
      return [p('sofa', 0, 0, 0, 0, [1.1, 1, 1.2])];
    case 'plant':
      return [p('plant', 0, 0, 0)];
    case 'huddle-table':
      return [p('huddle-table', 0, 0, 0, 0, [0.93, 1, 0.93])];
    case 'whiteboard':
      return [p('whiteboard', 0, 0, 0, 0, [0.9, 1.2, 0.8])];
    case 'bookshelf':
      return [p('bookshelf', 0, 0, 0, 0, [0.8, 1, 0.8])];
    case 'lamp':
      return [p('lamp', 0, 0, 0)];
    case 'rug':
      return [p('rug', 0, 0, 0, 0, [0.67, 0.2, 0.7])];
  }
}

/** Pixel screens carried by an item (the PM desk shows project progress; the lab test board shows checks). */
export function itemScreens(item: FurnitureItem): ScreenMount[] {
  if (item.kind === 'station' && item.role === 'pm') return [{ kind: 'pm', x: 0, y: DESK_TOP + 0.5, z: -0.11, w: 0.8, h: 0.5 }];
  if (item.kind === 'test-board') return [{ kind: 'test-board', x: 0, y: 1.71, z: 0.12, w: 4.7, h: 1.5 }];
  return [];
}
