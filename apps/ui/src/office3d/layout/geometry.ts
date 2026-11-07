export type Vec2 = { x: number; z: number };
/** Axis-aligned rectangle; x0 < x1, z0 < z1. */
export type Rect = { x0: number; z0: number; x1: number; z1: number };

/** Overlapping area > 0; rectangles that merely touch edges do not intersect. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
}

export function contains(r: Rect, p: Vec2): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
}
