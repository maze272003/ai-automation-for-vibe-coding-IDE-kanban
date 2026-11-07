import { OFFICE_WINGS, type RoomSlot, type Wing } from '@aik/contracts';
import { DEV_LENGTH, HALL_WIDTH, HUB_SIZE, LAB_LENGTH, SLOT_DEPTH, SLOT_LENGTH } from './dimensions.ts';
import { contains, intersects, type Rect, type Vec2 } from './geometry.ts';

export type SuiteLayout = {
  roomId: number;
  slot: RoomSlot;
  dev: Rect;
  lab: Rect;
  devDoor: Vec2;
  labDoor: Vec2;
  internalDoor: Vec2;
  /** Unit vector from the room toward the hallway. */
  facing: Vec2;
  signAnchor: Vec2;
};

export type BuildingLayout = {
  hub: Rect;
  hubExits: Record<Wing, Vec2>;
  hallways: Record<Wing, Rect | null>;
  suites: SuiteLayout[];
  bounds: Rect;
};

const H = HUB_SIZE / 2;
const HW = HALL_WIDTH / 2;
const EPS = 1e-6;

/** Outward direction of each wing. */
const DIR: Record<Wing, Vec2> = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };
/** Left-hand side when walking outward: (d.z, -d.x). */
const leftOf = (d: Vec2): Vec2 => ({ x: d.z, z: -d.x });

function rectOf(a: Vec2, b: Vec2): Rect {
  return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) };
}

/** Wing-local frame: `along` is distance from the hub centre, `off` is signed distance to the left of the axis. */
function mapPoint(wing: Wing, along: number, off: number): Vec2 {
  const d = DIR[wing];
  const l = leftOf(d);
  return { x: d.x * along + l.x * off, z: d.z * along + l.z * off };
}

function localRect(wing: Wing, a0: number, a1: number, o0: number, o1: number): Rect {
  return rectOf(mapPoint(wing, a0, o0), mapPoint(wing, a1, o1));
}

function suiteFor(roomId: number, slot: RoomSlot): SuiteLayout {
  const { wing, index, side } = slot;
  const sign = side === 'L' ? 1 : -1;
  const a0 = H + index * SLOT_LENGTH;
  const aMid = a0 + DEV_LENGTH;
  const a1 = aMid + LAB_LENGTH;
  const near = sign * HW;
  const far = sign * (HW + SLOT_DEPTH);
  const l = leftOf(DIR[wing]);
  return {
    roomId,
    slot,
    dev: localRect(wing, a0, aMid, near, far),
    lab: localRect(wing, aMid, a1, near, far),
    devDoor: mapPoint(wing, a0 + DEV_LENGTH / 2, near),
    labDoor: mapPoint(wing, aMid + LAB_LENGTH / 2, near),
    internalDoor: mapPoint(wing, aMid, sign * (HW + SLOT_DEPTH / 2)),
    facing: { x: -l.x * sign || 0, z: -l.z * sign || 0 },
    signAnchor: mapPoint(wing, a0 + SLOT_LENGTH / 2, near),
  };
}

export function buildingLayout(rooms: Array<{ roomId: number; slot: RoomSlot }>): BuildingLayout {
  const hub: Rect = { x0: -H, z0: -H, x1: H, z1: H };
  const maxIndex: Record<Wing, number> = { N: -1, E: -1, S: -1, W: -1 };
  for (const r of rooms) maxIndex[r.slot.wing] = Math.max(maxIndex[r.slot.wing], r.slot.index);

  const hallways = { N: null, E: null, S: null, W: null } as Record<Wing, Rect | null>;
  const hubExits = {} as Record<Wing, Vec2>;
  for (const w of OFFICE_WINGS) {
    hubExits[w] = mapPoint(w, H, 0);
    if (maxIndex[w] >= 0) hallways[w] = localRect(w, H, H + SLOT_LENGTH * (maxIndex[w] + 1), -HW, HW);
  }

  const suites = rooms.map((r) => suiteFor(r.roomId, r.slot));
  const all: Rect[] = [hub, ...OFFICE_WINGS.flatMap((w) => (hallways[w] ? [hallways[w]!] : [])), ...suites.flatMap((s) => [s.dev, s.lab])];
  const bounds: Rect = {
    x0: Math.min(...all.map((r) => r.x0)),
    z0: Math.min(...all.map((r) => r.z0)),
    x1: Math.max(...all.map((r) => r.x1)),
    z1: Math.max(...all.map((r) => r.z1)),
  };
  return { hub, hubExits, hallways, suites, bounds };
}

function onEdge(r: Rect, p: Vec2): boolean {
  if (!contains({ x0: r.x0 - EPS, z0: r.z0 - EPS, x1: r.x1 + EPS, z1: r.z1 + EPS }, p)) return false;
  return (
    Math.abs(p.x - r.x0) < EPS || Math.abs(p.x - r.x1) < EPS || Math.abs(p.z - r.z0) < EPS || Math.abs(p.z - r.z1) < EPS
  );
}

export function validateBuilding(b: BuildingLayout): string[] {
  const errs: string[] = [];
  for (const w of OFFICE_WINGS) {
    const h = b.hallways[w];
    if (!h) continue;
    if (intersects(h, b.hub)) errs.push(`hallway ${w} overlaps hub`);
    const touches = !intersects(h, b.hub) && onEdge(b.hub, { x: b.hubExits[w].x, z: b.hubExits[w].z }) && onEdge(h, b.hubExits[w]);
    if (!touches) errs.push(`hallway ${w} does not touch hub`);
  }
  const pieces = b.suites.flatMap((s) => [
    { id: `suite ${s.roomId} dev`, rect: s.dev, room: s.roomId },
    { id: `suite ${s.roomId} lab`, rect: s.lab, room: s.roomId },
  ]);
  for (const p of pieces) {
    if (intersects(p.rect, b.hub)) errs.push(`overlap: ${p.id} with hub`);
    for (const w of OFFICE_WINGS) {
      const h = b.hallways[w];
      if (h && intersects(p.rect, h)) errs.push(`overlap: ${p.id} with hallway ${w}`);
    }
  }
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (intersects(pieces[i]!.rect, pieces[j]!.rect)) errs.push(`overlap: ${pieces[i]!.id} with ${pieces[j]!.id}`);
    }
  }
  for (const s of b.suites) {
    const h = b.hallways[s.slot.wing];
    for (const [name, door] of [['dev', s.devDoor], ['lab', s.labDoor]] as const) {
      if (!h || !onEdge(h, door)) errs.push(`door: suite ${s.roomId} ${name} door not on wing ${s.slot.wing} hallway edge`);
    }
  }
  return errs;
}
