import { describe, expect, test } from 'vitest';
import { slotAt } from '@aik/contracts';
import { buildingLayout, validateBuilding } from '../../src/office3d/layout/building.ts';
import { intersects, type Rect } from '../../src/office3d/layout/geometry.ts';

const rooms = (n: number) => Array.from({ length: n }, (_, i) => ({ roomId: i + 1, slot: slotAt(i) }));
const ex = (r: Rect) => ({ x: r.x1 - r.x0, z: r.z1 - r.z0 });

describe('building layout', () => {
  test.each([0, 1, 4, 20, 57])('%i rooms: valid, no overlaps, all doors on a hallway', (n) => {
    const b = buildingLayout(rooms(n));
    expect(validateBuilding(b)).toEqual([]);
    expect(b.suites).toHaveLength(n);
  });

  test('adding rooms never moves existing suites', () => {
    const a = buildingLayout(rooms(9));
    const b = buildingLayout(rooms(10));
    for (const s of a.suites) expect(b.suites.find((x) => x.roomId === s.roomId)).toEqual(s);
  });

  test('20 rooms -> each wing ~66 m', () => {
    const b = buildingLayout(rooms(20));
    expect(b.hallways.N!.z1 - b.hallways.N!.z0).toBe(66);
  });

  test('suite rect sizes (slot 0 is wing N, runs along z)', () => {
    const s = buildingLayout(rooms(1)).suites[0]!;
    expect(ex(s.dev).z).toBe(14);
    expect(ex(s.dev).x).toBe(12);
    expect(ex(s.lab).z).toBe(8);
  });

  test('empty wings have no hallway; hub is 36 m centred at origin', () => {
    const b = buildingLayout(rooms(1));
    expect(b.hallways.E).toBeNull();
    expect(b.hub).toEqual({ x0: -18, z0: -18, x1: 18, z1: 18 });
  });

  test('wing directions and left side', () => {
    const b = buildingLayout(rooms(8));
    const find = (wing: string, side: string) => b.suites.find((s) => s.slot.wing === wing && s.slot.side === side)!;
    expect(b.hallways.N!.z1).toBeLessThanOrEqual(-18);
    expect(b.hallways.E!.x0).toBe(18);
    expect(b.hallways.S!.z0).toBe(18);
    expect(b.hallways.W!.x1).toBe(-18);
    expect(find('N', 'L').dev.x1).toBeLessThan(0);
    expect(find('E', 'L').dev.z1).toBeLessThan(0);
    expect(find('S', 'L').dev.x0).toBeGreaterThan(0);
    expect(find('W', 'L').dev.z0).toBeGreaterThan(0);
    expect(find('N', 'L').facing).toEqual({ x: 1, z: 0 });
  });

  test('dev room is the hub-side part; suites never intersect the hub', () => {
    const b = buildingLayout(rooms(57));
    const n0 = b.suites.find((s) => s.slot.wing === 'N' && s.slot.index === 0)!;
    expect(n0.dev.z1).toBe(-18);
    expect(n0.lab.z1).toBe(n0.dev.z0);
    for (const s of b.suites) expect(intersects(s.dev, b.hub)).toBe(false);
  });

  test('validateBuilding reports a moved door and an overlap', () => {
    const b = buildingLayout(rooms(2));
    b.suites[0]!.devDoor = { x: 100, z: 100 };
    expect(validateBuilding(b).some((m) => m.includes('door'))).toBe(true);
    const c = buildingLayout(rooms(1));
    c.suites.push({ ...c.suites[0]!, roomId: 99 });
    expect(validateBuilding(c).some((m) => m.includes('overlap'))).toBe(true);
  });
});
