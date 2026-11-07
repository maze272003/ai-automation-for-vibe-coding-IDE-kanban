import { describe, expect, test } from 'vitest';
import { slotAt, type FurnitureItem } from '@aik/contracts';
import { buildingLayout } from '../../src/office3d/layout/building.ts';
import { DEV_LENGTH, SLOT_DEPTH } from '../../src/office3d/layout/dimensions.ts';
import { contains, type Vec2 } from '../../src/office3d/layout/geometry.ts';
import { defaultRoomLayout } from '../../src/office3d/layout/room.ts';
import { resolveMove, wallSegments } from '../../src/office3d/scene/camera/collision.ts';
import { FLY_MS, flyDuration, flyPose, overviewPose, roomPose, walkStartPose, type CameraPose } from '../../src/office3d/scene/camera/fly.ts';
import { roomDirToWorld, roomToWorld, suiteFrame } from '../../src/office3d/scene/transform.ts';
import { officeKeyAction } from '../../src/office3d/scene/camera/keys.ts';
import { SHORTCUTS_BY_ID } from '../../src/lib/shortcuts.ts';

const a: CameraPose = { position: [0, 10, 0], target: [0, 0, 0] };
const b: CameraPose = { position: [20, 4, -10], target: [10, 1, -5] };

describe('flyPose', () => {
  test('flyPose endpoints and midpoint easing', () => {
    expect(flyPose(a, b, 0)).toEqual(a);
    expect(flyPose(a, b, 1)).toEqual(b);
    expect(flyPose(a, b, 0.5).position[0]).toBeCloseTo((a.position[0] + b.position[0]) / 2);
    expect(flyPose(a, b, 0.5).target[2]).toBeCloseTo((a.target[2] + b.target[2]) / 2);
  });

  test('ease-in-out cubic: slow start and slow end, t clamped to 0..1', () => {
    // easeInOutCubic(0.25) = 4 * 0.25^3 = 0.0625
    expect(flyPose(a, b, 0.25).position[0]).toBeCloseTo(20 * 0.0625);
    expect(flyPose(a, b, 0.75).position[0]).toBeCloseTo(20 * 0.9375);
    expect(flyPose(a, b, -1)).toEqual(a);
    expect(flyPose(a, b, 2)).toEqual(b);
  });

  test('FLY_MS is 800 and is divided by flySpeed', () => {
    expect(FLY_MS).toBe(800);
    expect(flyDuration(1)).toBe(800);
    expect(flyDuration(2)).toBe(400);
    expect(flyDuration(0.5)).toBe(1600);
  });
});

const building = buildingLayout([
  { roomId: 1, slot: slotAt(0) },
  { roomId: 2, slot: slotAt(4) }, // N:0:R, the mirrored side of the same hallway
]);
const left = building.suites.find((s) => s.slot.side === 'L')!;
const right = building.suites.find((s) => s.slot.side === 'R')!;

describe('camera poses', () => {
  test('overviewPose looks down at the centre of the bounds from above', () => {
    const r = { x0: -20, z0: -10, x1: 40, z1: 30 };
    const p = overviewPose(r);
    expect(p.target).toEqual([10, 0, 10]);
    expect(p.position[1]).toBeGreaterThan(30);
    const dist = Math.hypot(p.position[0] - 10, p.position[1], p.position[2] - 10);
    expect(dist).toBeGreaterThanOrEqual(60 * 0.9);
  });

  test.each([
    ['L', left],
    ['R', right],
  ] as const)('roomPose (%s): inside the dev room near the door, looking at the back wall', (_n, s) => {
    const p = roomPose(s);
    const pos = { x: p.position[0], z: p.position[2] };
    const tgt = { x: p.target[0], z: p.target[2] };
    expect(contains(s.dev, pos)).toBe(true);
    expect(contains(s.dev, tgt)).toBe(true);
    expect(Math.hypot(pos.x - s.devDoor.x, pos.z - s.devDoor.z)).toBeLessThan(2);
    // The view direction points from the door toward the back wall (= -facing).
    const dx = tgt.x - pos.x;
    const dz = tgt.z - pos.z;
    const len = Math.hypot(dx, dz);
    expect(dx / len).toBeCloseTo(-s.facing.x);
    expect(dz / len).toBeCloseTo(-s.facing.z);
    expect(p.position[1]).toBeGreaterThan(1);
    expect(p.position[1]).toBeLessThan(3.5);
  });
});

describe('collision', () => {
  const layouts = new Map<number, FurnitureItem[]>(building.suites.map((s) => [s.roomId, defaultRoomLayout()]));
  const segments = wallSegments(building, layouts);
  const add = (p: Vec2, d: Vec2): Vec2 => ({ x: p.x + d.x, z: p.z + d.z });

  test.each([
    ['L', left],
    ['R', right],
  ] as const)('resolveMove stops at a wall and passes through a door gap (%s)', (_n, s) => {
    const f = suiteFrame(s);
    const inward = roomDirToWorld(f, 0, -2.5); // from the hallway into the room
    // In the hallway in front of the glass, away from the door: blocked by the glass front.
    const wallStart = roomToWorld(f, 'dev', 3.5, SLOT_DEPTH + 1);
    const blocked = resolveMove(wallStart, inward, segments);
    const frontZ = (p: Vec2) => {
      // room-local z of a world point (inverse of the axis-aligned frame).
      const o = f.origin.dev;
      return (p.x - o.x) * f.az.x + (p.z - o.z) * f.az.z;
    };
    expect(frontZ(blocked)).toBeGreaterThanOrEqual(SLOT_DEPTH + 0.3 - 1e-6);
    // In front of the dev door: walks through the gap into the room.
    const doorStart = roomToWorld(f, 'dev', DEV_LENGTH / 2, SLOT_DEPTH + 1);
    const through = resolveMove(doorStart, inward, segments);
    expect(through.x).toBeCloseTo(add(doorStart, inward).x);
    expect(through.z).toBeCloseTo(add(doorStart, inward).z);
    expect(contains(s.dev, through)).toBe(true);
  });

  test('resolveMove slides along a wall instead of stopping dead', () => {
    const f = suiteFrame(left);
    const start = roomToWorld(f, 'dev', 3.5, SLOT_DEPTH + 1);
    const delta = roomDirToWorld(f, 2, -2.5); // diagonal into the glass front
    const end = resolveMove(start, delta, segments);
    const o = f.origin.dev;
    const localX = (p: Vec2) => (p.x - o.x) * f.ax.x + (p.z - o.z) * f.ax.z;
    expect(localX(end) - localX(start)).toBeCloseTo(2, 1);
  });

  test('furniture blocks movement; a free move is unchanged', () => {
    const f = suiteFrame(left);
    // Walk from the walkway toward the reviewer station (centre 9, 3.5; footprint 2.4 x 2).
    const start = roomToWorld(f, 'dev', 7, 3.5);
    const end = resolveMove(start, roomDirToWorld(f, 2, 0), segments);
    const o = f.origin.dev;
    const localX = (p: Vec2) => (p.x - o.x) * f.ax.x + (p.z - o.z) * f.ax.z;
    expect(localX(end)).toBeLessThanOrEqual(9 - 1.2 - 0.3 + 1e-6);
    const free = resolveMove({ x: 0, z: 0 }, { x: 1, z: 0.5 }, segments);
    expect(free.x).toBeCloseTo(1);
    expect(free.z).toBeCloseTo(0.5);
  });

  test('walk starts on free floor (in the selected room, or in the hub)', () => {
    for (const s of [left, right, null]) {
      const p = walkStartPose(s);
      expect(p.position[1]).toBeCloseTo(1.6);
      const start = { x: p.position[0], z: p.position[2] };
      if (s) expect(contains(s.dev, start)).toBe(true);
      // Free to step half a metre toward the target.
      const dir = { x: p.target[0] - start.x, z: p.target[2] - start.z };
      const l = Math.hypot(dir.x, dir.z);
      const step = { x: (dir.x / l) * 0.5, z: (dir.z / l) * 0.5 };
      const end = resolveMove(start, step, segments);
      expect(end.x).toBeCloseTo(start.x + step.x);
      expect(end.z).toBeCloseTo(start.z + step.z);
    }
  });

  test('the hub wall blocks except at a wing exit', () => {
    // The hub is -18..18; only wing N has a hallway.
    expect(left.slot.wing).toBe('N');
    expect(right.slot.wing).toBe('N');
    // East wall (no wing E): blocked.
    const east = resolveMove({ x: 16, z: 3 }, { x: 4, z: 0 }, segments);
    expect(east.x).toBeLessThan(18 - 0.15);
    // North exit (|x| < 2.5): walks out of the hub into the hallway.
    const north = resolveMove({ x: 0, z: -15 }, { x: 0, z: -6 }, segments);
    expect(north.z).toBeCloseTo(-21);
  });
});

test('shortcuts registry has office.walk with chord v in Local group', () => {
  expect(SHORTCUTS_BY_ID['office.walk']).toMatchObject({ chord: 'v', group: 'Local' });
  expect(SHORTCUTS_BY_ID['office.search']).toMatchObject({ chord: '/', group: 'Local', scope: 'local' });
  expect(SHORTCUTS_BY_ID['office.back']).toMatchObject({ chord: 'escape', group: 'Local', scope: 'local' });
});

describe('officeKeyAction', () => {
  const ctx = { walkEnabled: true, modalOpen: false };
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: null, ...extra });

  test('V toggles walk only when walk mode is enabled', () => {
    expect(officeKeyAction(key('v'), ctx)).toBe('walk');
    expect(officeKeyAction(key('V'), ctx)).toBe('walk');
    expect(officeKeyAction(key('v'), { ...ctx, walkEnabled: false })).toBeNull();
    expect(officeKeyAction(key('v', { ctrlKey: true }), ctx)).toBeNull();
  });

  test('key auto-repeat never re-fires a toggle (holding V or Esc)', () => {
    expect(officeKeyAction(key('v', { repeat: true }), ctx)).toBeNull();
    expect(officeKeyAction(key('Escape', { repeat: true }), ctx)).toBeNull();
    expect(officeKeyAction(key('v', { repeat: false }), ctx)).toBe('walk');
  });

  test('Escape goes back to the overview; "/" is left to the quick-jump panel', () => {
    expect(officeKeyAction(key('Escape'), ctx)).toBe('back');
    expect(officeKeyAction(key('/'), ctx)).toBeNull();
  });

  test('never fires while typing or while a dialog is open', () => {
    const input = { tagName: 'INPUT', parentElement: null };
    expect(officeKeyAction(key('v', { target: input }), ctx)).toBeNull();
    expect(officeKeyAction(key('Escape', { target: { tagName: 'TEXTAREA' } }), ctx)).toBeNull();
    expect(officeKeyAction(key('v'), { ...ctx, modalOpen: true })).toBeNull();
    expect(officeKeyAction(key('Escape'), { ...ctx, modalOpen: true })).toBeNull();
  });
});
