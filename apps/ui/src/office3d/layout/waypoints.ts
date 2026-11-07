import type { FurnitureItem, StationRole } from '@aik/contracts';
import { DEV_LENGTH, LAB_LENGTH, SLOT_DEPTH } from './dimensions.ts';
import { FOOTPRINTS, devZoneSeats, type FootprintKey } from './footprints.ts';
import type { Rect, Vec2 } from './geometry.ts';

export type SpotKind =
  | 'door'
  | 'seat'
  | 'sofa'
  | 'coffee'
  | 'huddle'
  | 'test-board'
  | 'whiteboard'
  | 'lab-couch'
  | 'walkway'
  | 'internal-door';
export type Spot = {
  id: string;
  kind: SpotKind;
  area: 'dev' | 'lab';
  /** Suite coordinates: dev room as-is (x 0..14); the QA lab is shifted +14 m in x so both rooms share one plane. */
  pos: Vec2;
  role?: StationRole;
  capacityGroup?: string;
};
export type WaypointGraph = { spots: Spot[]; edges: Array<[string, string]> };

const LAB_OFFSET = DEV_LENGTH;
const SUITE_WIDTH = DEV_LENGTH + LAB_LENGTH;
const INTERNAL_DOOR_Z = 5.7;
const INTERNAL_DOOR_HALF = 0.8;
const MARGIN = 0.05;
const EPS = 1e-9;

type Obstacle = { id: string; rect: Rect };

const toSuite = (area: 'dev' | 'lab', x: number, z: number): Vec2 => ({ x: area === 'lab' ? x + LAB_OFFSET : x, z });

function footprintKey(it: FurnitureItem): FootprintKey | null {
  if (it.kind === 'station') return it.role ? (`station:${it.role}` as const) : null;
  return it.kind;
}

function obstacleOf(it: FurnitureItem): Obstacle | null {
  const key = footprintKey(it);
  if (!key || it.kind === 'rug') return null; // rugs are walkable
  const f = FOOTPRINTS[key];
  const quarter = Math.round(it.rotationY / 90) % 2 !== 0;
  const w = quarter ? f.d : f.w;
  const d = quarter ? f.w : f.d;
  const c = toSuite(it.area, it.x, it.z);
  return { id: it.id, rect: { x0: c.x - w / 2, z0: c.z - d / 2, x1: c.x + w / 2, z1: c.z + d / 2 } };
}

/** True when the segment passes through the interior of the rect (touching edges is allowed). */
function segmentHitsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < EPS) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  const ok =
    clip(-dx, a.x - r.x0 - 1e-6) &&
    clip(dx, r.x1 - a.x - 1e-6) &&
    clip(-dz, a.z - r.z0 - 1e-6) &&
    clip(dz, r.z1 - a.z - 1e-6);
  return ok && t1 - t0 > EPS;
}

const inflate = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, z0: r.z0 - m, x1: r.x1 + m, z1: r.z1 + m });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

export function buildWaypointGraph(
  items: FurnitureItem[],
  seatCounts: Partial<Record<StationRole, number>> = {},
): WaypointGraph {
  const spots: Spot[] = [];
  const owner = new Map<string, string>(); // spot id -> owning item id (its footprint does not block its own spot edge)
  const add = (s: Spot, ownerId?: string) => {
    spots.push(s);
    if (ownerId) owner.set(s.id, ownerId);
  };

  const obstacles = items.map(obstacleOf).filter((o): o is Obstacle => o !== null);

  add({ id: 'door-dev', kind: 'door', area: 'dev', pos: { x: DEV_LENGTH / 2, z: SLOT_DEPTH } });
  add({ id: 'door-lab', kind: 'door', area: 'lab', pos: toSuite('lab', LAB_LENGTH / 2, SLOT_DEPTH) });
  add({ id: 'internal-door', kind: 'internal-door', area: 'dev', pos: { x: DEV_LENGTH, z: INTERNAL_DOOR_Z } });

  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const c = toSuite(it.area, it.x, it.z);
    const rad = (it.rotationY * Math.PI) / 180;
    const face = { x: Math.sin(rad), z: Math.cos(rad) }; // unit vector the item faces (0 deg faces +z, into the room)
    switch (it.kind) {
      case 'station': {
        if (!it.role) break;
        const f = FOOTPRINTS[`station:${it.role}`];
        if (it.role === 'implementer') {
          const n = devZoneSeats(seatCounts.implementer ?? 2).seats;
          for (let k = 0; k < n; k++) {
            add(
              {
                id: `seat-implementer-${k}`,
                kind: 'seat',
                area: it.area,
                role: 'implementer',
                pos: { x: c.x + (k % 2 === 0 ? -1 : 1), z: c.z - f.d / 2 + 1 + Math.floor(k / 2) * 2 },
              },
              it.id,
            );
          }
        } else {
          const n = Math.min(2, Math.max(1, seatCounts[it.role] ?? 1));
          for (let k = 0; k < n; k++) {
            add(
              {
                id: `seat-${it.role}-${k}`,
                kind: 'seat',
                area: it.area,
                role: it.role,
                pos: { x: c.x + (k - (n - 1) / 2) * 1.2, z: c.z + f.d / 2 + 0.4 },
              },
              it.id,
            );
          }
        }
        break;
      }
      case 'reading-lounge':
        for (let k = 0; k < 3; k++) {
          add(
            { id: `sofa-${k}`, kind: 'sofa', area: it.area, capacityGroup: 'lounge', pos: { x: c.x - 1.2 + 1.2 * k, z: c.z } },
            it.id,
          );
        }
        break;
      case 'coffee-bar':
        for (let k = 0; k < 3; k++) {
          add({ id: `coffee-${k}`, kind: 'coffee', area: it.area, pos: { x: c.x - 1.2 + 1.2 * k, z: c.z - 0.9 } }, it.id);
        }
        break;
      case 'huddle':
        (
          [
            [-0.7, -1.4],
            [0.7, -1.4],
            [-0.7, 1.4],
            [0.7, 1.4],
          ] as const
        ).forEach(([dx, dz], k) => {
          add({ id: `huddle-${k}`, kind: 'huddle', area: it.area, pos: { x: c.x + dx, z: c.z + dz } }, it.id);
        });
        break;
      case 'test-board':
        add({ id: 'test-board', kind: 'test-board', area: it.area, pos: { x: c.x + face.x * 0.9, z: c.z + face.z * 0.9 } }, it.id);
        break;
      case 'audit-whiteboard':
        add({ id: 'whiteboard', kind: 'whiteboard', area: it.area, pos: { x: c.x + face.x * 0.9, z: c.z + face.z * 0.9 } }, it.id);
        break;
      case 'lab-couch':
        for (let k = 0; k < 2; k++) {
          add({ id: `lab-couch-${k}`, kind: 'lab-couch', area: it.area, pos: { x: c.x - 0.6 + 1.2 * k, z: c.z } }, it.id);
        }
        break;
      default:
        break;
    }
  }

  // Walkway nodes on a 1 m grid, in free floor.
  const inflated = obstacles.map((o) => inflate(o.rect, MARGIN));
  const nodeAt = new Map<string, Spot>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  for (let ix = 0; ix < SUITE_WIDTH; ix++) {
    for (let iz = 0; iz < SLOT_DEPTH; iz++) {
      const pos = { x: ix + 0.5, z: iz + 0.5 };
      if (inflated.some((r) => pos.x > r.x0 && pos.x < r.x1 && pos.z > r.z0 && pos.z < r.z1)) continue;
      const s: Spot = { id: `w-${ix}-${iz}`, kind: 'walkway', area: ix < DEV_LENGTH ? 'dev' : 'lab', pos };
      nodeAt.set(key(ix, iz), s);
      spots.push(s);
    }
  }

  const edges: Array<[string, string]> = [];
  const freeSegment = (a: Vec2, b: Vec2, ignore?: string) =>
    !obstacles.some((o) => o.id !== ignore && segmentHitsRect(a, b, o.rect));
  for (const [k, n] of nodeAt) {
    const [ix, iz] = k.split(',').map(Number) as [number, number];
    for (const [nx, nz] of [
      [ix + 1, iz],
      [ix, iz + 1],
    ] as const) {
      const m = nodeAt.get(key(nx, nz));
      if (!m) continue;
      if (ix === DEV_LENGTH - 1 && nx === DEV_LENGTH) continue; // partition wall: crossed only via the internal door
      if (freeSegment(n.pos, m.pos)) edges.push([n.id, m.id]);
    }
  }

  const nodes = [...nodeAt.values()];
  const byDistance = (from: Vec2) => [...nodes].sort((x, y) => dist(x.pos, from) - dist(y.pos, from));

  // The internal door links one node on each side of the partition wall.
  const internal = spots.find((s) => s.kind === 'internal-door')!;
  const nearDoor = byDistance(internal.pos).filter((n) => Math.abs(n.pos.z - internal.pos.z) < INTERNAL_DOOR_HALF + 0.5);
  for (const west of [true, false]) {
    const n = nearDoor.find((c) => c.pos.x < DEV_LENGTH === west && freeSegment(internal.pos, c.pos));
    if (n) edges.push([internal.id, n.id]);
  }

  // Attach spots to the walkway component that holds the dev door, so none lands in a sealed-off floor pocket.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const s of spots) parent.set(s.id, s.id);
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const doorPos = spots.find((s) => s.id === 'door-dev')!.pos;
  const doorNode = byDistance(doorPos).find((n) => freeSegment(doorPos, n.pos));
  const main = doorNode ? find(doorNode.id) : '';

  for (const s of spots) {
    if (s.kind === 'walkway' || s.kind === 'internal-door') continue;
    const ign = owner.get(s.id);
    const reachable = byDistance(s.pos).filter((n) => freeSegment(s.pos, n.pos, ign));
    const hit = reachable.find((n) => find(n.id) === main) ?? reachable[0];
    if (hit) edges.push([s.id, hit.id]);
  }
  return { spots, edges };
}

const adjacency = new WeakMap<WaypointGraph, Map<string, string[]>>();
function adjOf(g: WaypointGraph): Map<string, string[]> {
  let a = adjacency.get(g);
  if (!a) {
    a = new Map();
    for (const s of g.spots) a.set(s.id, []);
    for (const [u, v] of g.edges) {
      a.get(u)?.push(v);
      a.get(v)?.push(u);
    }
    adjacency.set(g, a);
  }
  return a;
}

/** Every non-walkway spot (doors, seats, activity spots) is reachable from the dev door. */
export function isConnected(g: WaypointGraph): boolean {
  if (!g.spots.some((s) => s.id === 'door-dev')) return false;
  const adj = adjOf(g);
  const seen = new Set<string>(['door-dev']);
  const stack = ['door-dev'];
  while (stack.length) {
    for (const n of adj.get(stack.pop()!) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return g.spots.every((s) => s.kind === 'walkway' || seen.has(s.id));
}

/** A* on straight-line distance; returns spot positions from `from` to `to`, or [] when unreachable. */
export function findPath(g: WaypointGraph, fromSpotId: string, toSpotId: string): Vec2[] {
  const byId = new Map(g.spots.map((s) => [s.id, s]));
  const from = byId.get(fromSpotId);
  const to = byId.get(toSpotId);
  if (!from || !to) return [];
  const adj = adjOf(g);
  const gScore = new Map<string, number>([[from.id, 0]]);
  const prev = new Map<string, string>();
  const open = new Map<string, number>([[from.id, dist(from.pos, to.pos)]]);
  const closed = new Set<string>();
  while (open.size) {
    let cur = '';
    let best = Infinity;
    for (const [id, f] of open) {
      if (f < best) {
        best = f;
        cur = id;
      }
    }
    open.delete(cur);
    if (cur === to.id) {
      const out: Vec2[] = [];
      for (let id: string | undefined = cur; id; id = prev.get(id)) out.push(byId.get(id)!.pos);
      return out.reverse().map((p) => ({ x: p.x, z: p.z }));
    }
    closed.add(cur);
    const cp = byId.get(cur)!.pos;
    for (const n of adj.get(cur) ?? []) {
      if (closed.has(n)) continue;
      const np = byId.get(n)!.pos;
      const tentative = gScore.get(cur)! + dist(cp, np);
      if (tentative < (gScore.get(n) ?? Infinity)) {
        gScore.set(n, tentative);
        prev.set(n, cur);
        open.set(n, tentative + dist(np, to.pos));
      }
    }
  }
  return [];
}

export function freeSpot(
  g: WaypointGraph,
  kind: SpotKind,
  occupied: ReadonlySet<string>,
  area?: 'dev' | 'lab',
): Spot | null {
  return g.spots.find((s) => s.kind === kind && (!area || s.area === area) && !occupied.has(s.id)) ?? null;
}
