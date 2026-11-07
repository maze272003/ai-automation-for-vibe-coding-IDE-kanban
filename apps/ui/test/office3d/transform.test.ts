import { describe, expect, test } from 'vitest';
import { slotAt } from '@aik/contracts';
import { buildingLayout } from '../../src/office3d/layout/building.ts';
import { DEV_LENGTH, LAB_LENGTH, SLOT_DEPTH } from '../../src/office3d/layout/dimensions.ts';
import { contains } from '../../src/office3d/layout/geometry.ts';
import { itemYaw, roomRectToWorld, roomToWorld, suiteFrame, suiteToWorld } from '../../src/office3d/scene/transform.ts';

const suites = buildingLayout(Array.from({ length: 8 }, (_, i) => ({ roomId: i + 1, slot: slotAt(i) }))).suites;
const close = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
};

describe('room-local -> world transform', () => {
  test.each(suites.map((s) => [`${s.slot.wing}${s.slot.index}${s.slot.side}`, s] as const))('%s: doors land on the layout doors', (_n, s) => {
    const f = suiteFrame(s);
    close(roomToWorld(f, 'dev', DEV_LENGTH / 2, SLOT_DEPTH), s.devDoor);
    close(roomToWorld(f, 'lab', LAB_LENGTH / 2, SLOT_DEPTH), s.labDoor);
    close(roomToWorld(f, 'dev', DEV_LENGTH, SLOT_DEPTH / 2), s.internalDoor);
    close(suiteToWorld(f, { x: DEV_LENGTH + LAB_LENGTH / 2, z: SLOT_DEPTH }), s.labDoor);
  });

  test.each(suites.map((s) => [`${s.slot.wing}${s.slot.index}${s.slot.side}`, s] as const))('%s: room rects map onto the suite rects', (_n, s) => {
    const f = suiteFrame(s);
    expect(roomRectToWorld(f, 'dev', { x0: 0, z0: 0, x1: DEV_LENGTH, z1: SLOT_DEPTH })).toEqual(s.dev);
    expect(roomRectToWorld(f, 'lab', { x0: 0, z0: 0, x1: LAB_LENGTH, z1: SLOT_DEPTH })).toEqual(s.lab);
    expect(contains(s.dev, roomToWorld(f, 'dev', 1.2, 3.5))).toBe(true);
  });

  test('left suites are proper rotations, right suites mirrored', () => {
    for (const s of suites) expect(suiteFrame(s).mirrored).toBe(s.slot.side === 'R');
  });

  test('itemYaw points an item front (rotationY 0) toward the hallway', () => {
    for (const s of suites) {
      const yaw = itemYaw(suiteFrame(s), 0);
      close({ x: Math.sin(yaw), z: Math.cos(yaw) }, s.facing);
    }
  });
});
