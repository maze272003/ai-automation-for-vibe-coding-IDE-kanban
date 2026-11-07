import { slotKey, type FurnitureItem } from '@aik/contracts';
import type { BuildingLayout } from '../../layout/building.ts';
import { rectOf } from '../../layout/footprints.ts';
import type { Rect, Vec2 } from '../../layout/geometry.ts';
import { hubStructure } from '../hub.ts';
import { emptyStructure, shellStructure, suiteStructure, type Box } from '../structure.ts';
import { roomRectToWorld, suiteFrame } from '../transform.ts';

/** A wall segment on the floor plane (world metres). */
export type Segment = { a: Vec2; b: Vec2 };

/** Boxes starting below this height block a walker (window glass above a sill, glass above doors do not). */
const BLOCK_Y = 0.5;
/** Furniture a walker steps over. */
const WALKABLE = new Set<FurnitureItem['kind']>(['rug']);

function rectSegments(r: Rect, out: Segment[]): void {
  const p00 = { x: r.x0, z: r.z0 };
  const p10 = { x: r.x1, z: r.z0 };
  const p11 = { x: r.x1, z: r.z1 };
  const p01 = { x: r.x0, z: r.z1 };
  out.push({ a: p00, b: p10 }, { a: p10, b: p11 }, { a: p11, b: p01 }, { a: p01, b: p00 });
}

/**
 * The 2D collision outline of the building (spec 6.6: "2D grid of wall segments from the layout — no physics
 * engine"). Walls come from the same pure builders that draw the scene (structure.ts / hub.ts), so collision
 * matches what is rendered exactly: door openings are real gaps. Every box that starts at floor level becomes
 * its rectangle outline. Room furniture (except rugs) blocks too, mapped through the suite frame (mirrored
 * right-side suites are handled by transform.ts). `b.suites` must hold the visible suites only: a slot with no
 * suite gets the solid hallway wall, as in the scene.
 */
export function wallSegments(b: BuildingLayout, roomLayouts: Map<number, FurnitureItem[]>): Segment[] {
  const s = emptyStructure();
  shellStructure(s, b, new Set(b.suites.map((x) => slotKey(x.slot))));
  hubStructure(s);
  for (const suite of b.suites) suiteStructure(s, suite, { roomId: suite.roomId, dim: false, accent: '#000000' });
  const out: Segment[] = [];
  const blocking = (x: Box) => x.y0 < BLOCK_Y;
  for (const x of [...s.solid, ...s.glass, ...s.frame]) if (blocking(x)) rectSegments(x, out);
  for (const suite of b.suites) {
    const items = roomLayouts.get(suite.roomId);
    if (!items) continue;
    const f = suiteFrame(suite);
    for (const item of items) {
      if (WALKABLE.has(item.kind)) continue;
      const r = rectOf(item);
      if (r) rectSegments(roomRectToWorld(f, item.area, r), out);
    }
  }
  return out;
}

function closestOnSegment(p: Vec2, s: Segment): Vec2 {
  const dx = s.b.x - s.a.x;
  const dz = s.b.z - s.a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / len2));
  return { x: s.a.x + dx * t, z: s.a.z + dz * t };
}

/**
 * Moves a circle of `radius` from `pos` by `delta`, sliding along walls. The move is split into steps
 * shorter than the radius (no tunnelling through thin glass); after each step the circle is pushed out of
 * every segment it overlaps, which removes only the component into the wall and keeps the tangential one.
 */
export function resolveMove(pos: Vec2, delta: Vec2, segments: Segment[], radius = 0.3): Vec2 {
  const dist = Math.hypot(delta.x, delta.z);
  if (dist === 0) return { ...pos };
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.4)));
  const sx = delta.x / steps;
  const sz = delta.z / steps;
  const reach = radius + Math.hypot(sx, sz);
  let p = { ...pos };
  for (let i = 0; i < steps; i++) {
    const prev = p;
    p = { x: p.x + sx, z: p.z + sz };
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const seg of segments) {
        // Cheap reject on the segment's bounding box.
        if (p.x < Math.min(seg.a.x, seg.b.x) - reach || p.x > Math.max(seg.a.x, seg.b.x) + reach) continue;
        if (p.z < Math.min(seg.a.z, seg.b.z) - reach || p.z > Math.max(seg.a.z, seg.b.z) + reach) continue;
        const c = closestOnSegment(p, seg);
        let nx = p.x - c.x;
        let nz = p.z - c.z;
        const d = Math.hypot(nx, nz);
        if (d >= radius) continue;
        if (d < 1e-9) {
          // Exactly on the segment: push back toward where the step came from.
          nx = prev.x - p.x;
          nz = prev.z - p.z;
          const l = Math.hypot(nx, nz) || 1;
          p = { x: c.x + (nx / l) * radius, z: c.z + (nz / l) * radius };
        } else {
          p = { x: c.x + (nx / d) * radius, z: c.z + (nz / d) * radius };
        }
        moved = true;
      }
      if (!moved) break;
    }
  }
  return p;
}
