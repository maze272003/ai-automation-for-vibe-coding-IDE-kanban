import { DEV_LENGTH, LAB_LENGTH, SLOT_DEPTH } from '../layout/dimensions.ts';
import type { SuiteLayout } from '../layout/building.ts';
import type { Rect, Vec2 } from '../layout/geometry.ts';

/**
 * THE room-local -> world transform (the one place it is defined; agents, cameras and the scene all use it).
 *
 * Coordinate systems:
 * - World: metres, y up, the hub centred on the origin (layout/building.ts). three.js uses the same axes.
 * - Room-local (layout/room.ts): per area. Dev x 0..14, lab x 0..8; z 0..12 with z = 0 at the back wall and
 *   z = 12 on the glass front (hallway side). The lab is always on the dev room's +x side (the internal door
 *   is on the dev room's x = 14 wall).
 * - Suite coordinates (layout/waypoints.ts): dev as-is, lab shifted +DEV_LENGTH in x.
 * - Item-local (layout/footprints.ts `localToRoom`): offsets around an item's centre, rotated by rotationY
 *   degrees; at rotationY 0 item-local +z points toward the glass front.
 *
 * Mapping: room-local +x runs along the hallway away from the hub (dev door -> lab door), room-local +z runs
 * along `suite.facing` (toward the hallway). On the left side of a wing that basis is a proper rotation; on
 * the right side it is a mirror image (the lab must stay outward of the dev room on both sides), so the
 * pipeline row reads left -> right from the hallway on L suites and right -> left on R suites.
 *
 * Mirroring and props: placing a model with a reflected matrix would flip its triangle winding, so props are
 * never reflected. `itemYaw` instead returns the rotation that maps the item's local +z (its "front") to the
 * correct world direction; on mirrored suites the item's local x is therefore not mirrored. All voxel models
 * are (near) symmetric in x, so the difference is invisible, and positions are always exact.
 */
export type Area = 'dev' | 'lab';

export type SuiteFrame = {
  /** World position of room-local (0, 0) for each area (the back-wall corner nearest the hub). */
  origin: Record<Area, Vec2>;
  /** World unit vector of room-local +x. */
  ax: Vec2;
  /** World unit vector of room-local +z (= suite.facing). */
  az: Vec2;
  /** True when the room-local basis is a reflection (right-hand side suites). */
  mirrored: boolean;
};

const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l || 0, z: v.z / l || 0 };
};

export function suiteFrame(s: SuiteLayout): SuiteFrame {
  const ax = unit({ x: s.labDoor.x - s.devDoor.x, z: s.labDoor.z - s.devDoor.z });
  const az = unit(s.facing);
  const origin = (door: Vec2, len: number): Vec2 => ({
    x: door.x - ax.x * (len / 2) - az.x * SLOT_DEPTH,
    z: door.z - ax.z * (len / 2) - az.z * SLOT_DEPTH,
  });
  // three.js yaw maps local (1,0) -> (cos, -sin) and (0,1) -> (sin, cos): proper iff az == (-ax.z, ax.x).
  const mirrored = Math.abs(az.x + ax.z) > 1e-6 || Math.abs(az.z - ax.x) > 1e-6;
  return { origin: { dev: origin(s.devDoor, DEV_LENGTH), lab: origin(s.labDoor, LAB_LENGTH) }, ax, az, mirrored };
}

const clean = (n: number) => Math.round(n * 1e9) / 1e9 || 0;

/** Room-local point -> world (x, z). */
export function roomToWorld(f: SuiteFrame, area: Area, x: number, z: number): Vec2 {
  const o = f.origin[area];
  return { x: clean(o.x + f.ax.x * x + f.az.x * z), z: clean(o.z + f.ax.z * x + f.az.z * z) };
}

/** Suite point (lab shifted +DEV_LENGTH, as used by the waypoint graph) -> world (x, z). */
export function suiteToWorld(f: SuiteFrame, p: Vec2): Vec2 {
  return roomToWorld(f, 'dev', p.x, p.z);
}

/** Room-local direction -> world direction. */
export function roomDirToWorld(f: SuiteFrame, dx: number, dz: number): Vec2 {
  return { x: clean(f.ax.x * dx + f.az.x * dz), z: clean(f.ax.z * dx + f.az.z * dz) };
}

/**
 * three.js `rotation.y` (radians) for an object placed with `rotationY` degrees in room-local space: the
 * object's local +z ends up pointing along the room-local direction (sin r, cos r), mapped to world.
 */
export function itemYaw(f: SuiteFrame, rotationYDeg: number): number {
  const r = (rotationYDeg * Math.PI) / 180;
  const w = roomDirToWorld(f, Math.sin(r), Math.cos(r));
  return Math.atan2(w.x, w.z);
}

/** Room-local axis-aligned rect -> world axis-aligned rect (the basis vectors are axis-aligned). */
export function roomRectToWorld(f: SuiteFrame, area: Area, r: Rect): Rect {
  const a = roomToWorld(f, area, r.x0, r.z0);
  const b = roomToWorld(f, area, r.x1, r.z1);
  return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) };
}
