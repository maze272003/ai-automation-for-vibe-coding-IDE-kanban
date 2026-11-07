import { describe, expect, test } from 'vitest';
import type { FurnitureItem } from '@aik/contracts';
import { defaultRoomLayout, devZoneSeats, snapToGrid, stationSeats, validateLayout } from '../../src/office3d/layout/room.ts';
import { buildWaypointGraph, findPath, isConnected } from '../../src/office3d/layout/waypoints.ts';

const desk = (id: string, x: number, z: number, rotationY = 0, area: 'dev' | 'lab' = 'dev'): FurnitureItem => ({
  id, kind: 'desk', area, x, z, rotationY,
});

describe('default layout', () => {
  test('is valid', () => {
    expect(validateLayout(defaultRoomLayout())).toEqual({ ok: true, errors: [] });
  });
  test('ids are unique', () => {
    const ids = defaultRoomLayout().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('graph is connected with 3 sofa + 3 coffee spots; QA lab reachable from the dev door', () => {
    const g = buildWaypointGraph(defaultRoomLayout());
    expect(isConnected(g)).toBe(true);
    expect(g.spots.filter((s) => s.kind === 'sofa')).toHaveLength(3);
    expect(g.spots.filter((s) => s.kind === 'coffee')).toHaveLength(3);
    expect(findPath(g, 'door-dev', 'test-board').length).toBeGreaterThan(0);
  });
  test('stations run planner -> implementer -> reviewer -> pm left to right', () => {
    const x = (r: string) => defaultRoomLayout().find((i) => i.id === `station-${r}`)!.x;
    expect(x('planner')).toBeLessThan(x('implementer'));
    expect(x('implementer')).toBeLessThan(x('reviewer'));
    expect(x('reviewer')).toBeLessThan(x('pm'));
  });
});

describe('seat helpers', () => {
  test.each([[0, 2, 0], [1, 2, 0], [3, 3, 0], [8, 8, 0], [12, 8, 4]])('devZoneSeats(%i)', (n, seats, overflow) => {
    expect(devZoneSeats(n)).toEqual({ seats, overflow });
  });
  test.each([[0, 1, 0], [1, 1, 0], [2, 2, 0], [5, 2, 3]])('stationSeats(%i)', (n, seats, overflow) => {
    expect(stationSeats(n)).toEqual({ seats, overflow });
  });
  test('snapToGrid', () => {
    expect(snapToGrid(1.13)).toBe(1.25);
    expect(snapToGrid(1.1)).toBe(1);
  });
});

describe('validateLayout', () => {
  test('overlapping desks are rejected', () => {
    const l = [...defaultRoomLayout(), desk('x', 1, 2.5)];
    expect(validateLayout(l).ok).toBe(false);
  });
  test('blocking the walkway is rejected', () => {
    const r = validateLayout([...defaultRoomLayout(), desk('x', 7, 8)]);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/walkway/);
  });
  test('blocking a door swing is rejected', () => {
    const r = validateLayout([...defaultRoomLayout(), desk('x', 5.2, 11.4, 0, 'lab')]);
    expect(r.errors.join()).toMatch(/swing/);
  });
  test('item outside its room is rejected', () => {
    const r = validateLayout([...defaultRoomLayout(), desk('x', 7.5, 1, 0, 'lab')]);
    expect(r.errors.join()).toMatch(/outside/);
  });
  test('rotated footprints swap axes (90 deg) for bounds', () => {
    const ok = validateLayout([...defaultRoomLayout(), { id: 'bk', kind: 'bookshelf', area: 'lab', x: 7.75, z: 9, rotationY: 90 }]);
    expect(ok.errors).toEqual([]);
    const bad = validateLayout([...defaultRoomLayout(), { id: 'bk', kind: 'bookshelf', area: 'lab', x: 7.75, z: 9, rotationY: 0 }]);
    expect(bad.errors.join()).toMatch(/outside/);
  });
  test('deleting a special item is rejected', () => {
    expect(validateLayout(defaultRoomLayout().filter((i) => i.kind !== 'coffee-bar')).errors.join()).toMatch(/coffee-bar/);
  });
  test('duplicating a special item is rejected', () => {
    const dup: FurnitureItem = { id: 'huddle2', kind: 'huddle', area: 'dev', x: 12, z: 8, rotationY: 0 };
    expect(validateLayout([...defaultRoomLayout(), dup]).errors.join()).toMatch(/duplicate.*huddle/);
  });
  test('boxing in the couch (unreachable) is rejected', () => {
    const boxed: FurnitureItem[] = [
      ...defaultRoomLayout(),
      desk('b0', 1, 8.6),
      desk('b1', 4.7, 10.2, 90),
      { id: 'b2', kind: 'bookshelf', area: 'dev', x: 4.9, z: 11.4, rotationY: 0 },
    ];
    const r = validateLayout(boxed);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unreachable/);
  });
});
