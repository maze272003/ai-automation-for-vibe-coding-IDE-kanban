import { OFFICE_WINGS, type Wing } from '@aik/contracts';
import type { BuildingLayout, SuiteLayout } from '../layout/building.ts';
import { DEV_LENGTH, DOOR_WIDTH, HALL_WIDTH, HUB_SIZE, LAB_LENGTH, ROOM_HEIGHT, SLOT_DEPTH, SLOT_LENGTH } from '../layout/dimensions.ts';
import type { Rect, Vec2 } from '../layout/geometry.ts';
import { roomRectToWorld, suiteFrame, type Area, type SuiteFrame } from './transform.ts';

/**
 * Static building geometry as world-space boxes (pure, no three.js). Every box of a kind is drawn by one
 * InstancedMesh, so the whole shell costs a handful of draw calls regardless of the number of suites.
 */
export type Box = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; color: string };
/** Floor tile; `roomId` makes suite floors clickable (null = hub/hallway). */
export type Floor = { rect: Rect; y: number; color: string; roomId: number | null };
export type Structure = { solid: Box[]; glass: Box[]; frame: Box[]; floors: Floor[] };

export const WALL_T = 0.15;
const GLASS_T = 0.06;
const SILL = 1.0;
const HEAD = 3.0;
const DOOR_H = 2.3;
/** Internal door centre (room-local z), shared with layout/room.ts and layout/waypoints.ts. */
export const INTERNAL_DOOR_Z = 5.7;

export const COLORS = {
  slab: '#0b1220',
  hub: '#2b3546',
  hall: '#3b475a',
  dev: '#253043',
  lab: '#1f3a42',
  wall: '#3a4659',
  wallDark: '#2a3444',
  frame: '#8aa0b8',
  meeting: '#2f3b4f',
} as const;

const box = (r: Rect, y0: number, y1: number, color: string): Box => ({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y0, y1, color });

/** Split [a, b] around gaps [g0, g1] (sorted, inside). */
function spans(a: number, b: number, gaps: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cur = a;
  for (const [g0, g1] of [...gaps].sort((x, y) => x[0] - y[0])) {
    if (g0 > cur) out.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

/** An exterior wall with a window band: solid below SILL and above HEAD, glass between. */
function windowWall(s: Structure, r: Rect): void {
  s.solid.push(box(r, 0, SILL, COLORS.wall));
  s.solid.push(box(r, HEAD, ROOM_HEIGHT, COLORS.wall));
  s.glass.push(box(r, SILL, HEAD, ''));
  s.frame.push(box(r, SILL - 0.04, SILL, COLORS.frame));
}

/** A glass wall along one axis with door gaps (posts + glass above each door). */
function glassWall(s: Structure, along: 'x' | 'z', fixed0: number, fixed1: number, a: number, b: number, doors: number[], addRect: (r: Rect) => Rect): void {
  const mk = (p0: number, p1: number): Rect =>
    addRect(along === 'x' ? { x0: p0, x1: p1, z0: fixed0, z1: fixed1 } : { x0: fixed0, x1: fixed1, z0: p0, z1: p1 });
  const h = DOOR_WIDTH / 2;
  for (const [p0, p1] of spans(a, b, doors.map((d) => [d - h, d + h]))) s.glass.push(box(mk(p0, p1), 0, ROOM_HEIGHT, ''));
  for (const d of doors) {
    s.glass.push(box(mk(d - h, d + h), DOOR_H, ROOM_HEIGHT, ''));
    s.frame.push(box(mk(d - h - 0.05, d - h), 0, DOOR_H, COLORS.frame));
    s.frame.push(box(mk(d + h, d + h + 0.05), 0, DOOR_H, COLORS.frame));
    s.frame.push(box(mk(d - h, d + h), DOOR_H - 0.05, DOOR_H, COLORS.frame));
  }
  s.frame.push(box(mk(a, b), ROOM_HEIGHT - 0.05, ROOM_HEIGHT, COLORS.frame));
}

export type SuiteLook = { roomId: number; dim: boolean; accent: string };

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${((c((n >> 16) & 255) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0')}`;
}

/** Floors, walls, glass partition + internal door, glass fronts + doors and the accent inlay of one suite. */
export function suiteStructure(s: Structure, suite: SuiteLayout, look: SuiteLook, frame: SuiteFrame = suiteFrame(suite)): void {
  const k = look.dim ? 0.5 : 1;
  const w = (area: Area, r: Rect) => roomRectToWorld(frame, area, r);
  const D = SLOT_DEPTH;
  const T = WALL_T;
  const wall = shade(COLORS.wall, k);

  s.floors.push({ rect: w('dev', { x0: 0, z0: 0, x1: DEV_LENGTH, z1: D }), y: 0.02, color: shade(COLORS.dev, k), roomId: look.roomId });
  s.floors.push({ rect: w('lab', { x0: 0, z0: 0, x1: LAB_LENGTH, z1: D }), y: 0.02, color: shade(COLORS.lab, k), roomId: look.roomId });
  // Accent inlay along the walkway from the door to the back wall.
  s.floors.push({ rect: w('dev', { x0: DEV_LENGTH / 2 - 0.25, z0: 0.6, x1: DEV_LENGTH / 2 + 0.25, z1: D - 0.2 }), y: 0.03, color: shade(look.accent, 0.75 * k), roomId: look.roomId });

  // Back wall (exterior): a window at the hub end of the dev room, solid behind the screens.
  s.solid.push(box(w('dev', { x0: 0, z0: 0, x1: DEV_LENGTH, z1: T }), 0, SILL, wall));
  s.solid.push(box(w('dev', { x0: 0, z0: 0, x1: DEV_LENGTH, z1: T }), HEAD, ROOM_HEIGHT, wall));
  s.solid.push(box(w('dev', { x0: 2.4, z0: 0, x1: DEV_LENGTH, z1: T }), SILL, HEAD, wall));
  s.glass.push(box(w('dev', { x0: 0, z0: 0, x1: 2.4, z1: T }), SILL, HEAD, ''));
  s.solid.push(box(w('lab', { x0: 0, z0: 0, x1: LAB_LENGTH, z1: T }), 0, ROOM_HEIGHT, wall));
  // Side walls (inside the suite rect so neighbouring suites never overlap).
  s.solid.push(box(w('dev', { x0: 0, z0: T, x1: T, z1: D }), 0, ROOM_HEIGHT, wall));
  s.solid.push(box(w('lab', { x0: LAB_LENGTH - T, z0: T, x1: LAB_LENGTH, z1: D }), 0, ROOM_HEIGHT, wall));
  // Glass partition with the internal door (lab side of the boundary).
  glassWall(s, 'z', 0, GLASS_T, T, D - GLASS_T, [INTERNAL_DOOR_Z], (r) => w('lab', r));
  // Glass fronts with doors.
  glassWall(s, 'x', D - GLASS_T, D, T, DEV_LENGTH, [DEV_LENGTH / 2], (r) => w('dev', r));
  glassWall(s, 'x', D - GLASS_T, D, GLASS_T, LAB_LENGTH - T, [LAB_LENGTH / 2], (r) => w('lab', r));
}

/** Outward direction and left-hand normal of a wing (same convention as layout/building.ts). */
export const WING_DIR: Record<Wing, Vec2> = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };
const leftOf = (d: Vec2): Vec2 => ({ x: d.z, z: -d.x });

/** Wing-local rect (along from the hub centre, off = signed distance to the left of the wing axis) -> world. */
export function wingRect(wing: Wing, a0: number, a1: number, o0: number, o1: number): Rect {
  const d = WING_DIR[wing];
  const l = leftOf(d);
  const pt = (a: number, o: number) => ({ x: d.x * a + l.x * o, z: d.z * a + l.z * o });
  const p = pt(a0, o0);
  const q = pt(a1, o1);
  return { x0: Math.min(p.x, q.x), z0: Math.min(p.z, q.z), x1: Math.max(p.x, q.x), z1: Math.max(p.z, q.z) };
}

/**
 * Hub and hallway shell: slab, floors, hub walls with window bands and wing exits, hallway walls where a
 * slot has no visible suite, hallway end caps. `visibleSlots` holds `${wing}:${index}:${side}`.
 */
export function shellStructure(s: Structure, b: BuildingLayout, visibleSlots: Set<string>): void {
  const H = HUB_SIZE / 2;
  const HW = HALL_WIDTH / 2;
  const T = WALL_T;
  const m = 3;
  s.floors.push({ rect: { x0: b.bounds.x0 - m, z0: b.bounds.z0 - m, x1: b.bounds.x1 + m, z1: b.bounds.z1 + m }, y: 0, color: COLORS.slab, roomId: null });
  s.floors.push({ rect: b.hub, y: 0.01, color: COLORS.hub, roomId: null });
  for (const wing of OFFICE_WINGS) {
    const hall = b.hallways[wing];
    if (hall) s.floors.push({ rect: hall, y: 0.01, color: COLORS.hall, roomId: null });
    // Hub wall on this side (inside the hub), with the exit gap when the wing exists.
    const gaps: Array<[number, number]> = hall ? [[-HW, HW]] : [];
    for (const [o0, o1] of spans(-H, H, gaps)) windowWall(s, wingRect(wing, H - T, H, o0, o1));
    if (!hall) continue;
    const slots = Math.round(wingLength(hall, wing) / SLOT_LENGTH);
    for (let i = 0; i < slots; i++) {
      const a0 = H + i * SLOT_LENGTH;
      for (const side of ['L', 'R'] as const) {
        if (visibleSlots.has(`${wing}:${i}:${side}`)) continue;
        const sg = side === 'L' ? 1 : -1;
        windowWall(s, wingRect(wing, a0, a0 + SLOT_LENGTH, sg * HW, sg * (HW + T)));
      }
    }
    const end = H + slots * SLOT_LENGTH;
    windowWall(s, wingRect(wing, end, end + T, -HW - T, HW + T));
  }
}

function wingLength(hall: Rect, wing: Wing): number {
  return wing === 'N' || wing === 'S' ? hall.z1 - hall.z0 : hall.x1 - hall.x0;
}

/** A glass-walled meeting room inside the hub (door on the side facing `doorSide`). */
export function meetingRoom(s: Structure, r: Rect, doorSide: 'x0' | 'x1' | 'z0' | 'z1'): void {
  s.floors.push({ rect: r, y: 0.02, color: COLORS.meeting, roomId: null });
  const id = (q: Rect) => q;
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  glassWall(s, 'x', r.z0, r.z0 + GLASS_T, r.x0, r.x1, doorSide === 'z0' ? [cx] : [], id);
  glassWall(s, 'x', r.z1 - GLASS_T, r.z1, r.x0, r.x1, doorSide === 'z1' ? [cx] : [], id);
  glassWall(s, 'z', r.x0, r.x0 + GLASS_T, r.z0 + GLASS_T, r.z1 - GLASS_T, doorSide === 'x0' ? [cz] : [], id);
  glassWall(s, 'z', r.x1 - GLASS_T, r.x1, r.z0 + GLASS_T, r.z1 - GLASS_T, doorSide === 'x1' ? [cz] : [], id);
}

export const emptyStructure = (): Structure => ({ solid: [], glass: [], frame: [], floors: [] });
