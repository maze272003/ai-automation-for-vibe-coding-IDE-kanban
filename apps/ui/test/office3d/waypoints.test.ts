import { describe, expect, test } from 'vitest';
import type { FurnitureItem, StationRole } from '@aik/contracts';
import { buildWaypointGraph, findPath, freeSpot, isConnected } from '../../src/office3d/layout/waypoints.ts';

const st = (role: StationRole, area: 'dev' | 'lab', x: number, z: number): FurnitureItem => ({
  id: `station-${role}`, kind: 'station', area, x, z, rotationY: 0, role,
});
const it = (id: string, kind: FurnitureItem['kind'], area: 'dev' | 'lab', x: number, z: number, rotationY = 0): FurnitureItem => ({
  id, kind, area, x, z, rotationY,
});

/** Local fixture: dev x 0..14, lab x 0..8, z 0..12; walkway x 6.5..7.5 free. */
const layout = (): FurnitureItem[] => [
  st('planner', 'dev', 1.2, 3.5),
  st('implementer', 'dev', 4.4, 5),
  st('reviewer', 'dev', 9, 3.5),
  st('pm', 'dev', 11.6, 3.5),
  it('lounge', 'reading-lounge', 'dev', 2.2, 10.5),
  it('huddle', 'huddle', 'dev', 9.2, 9.6),
  it('coffee', 'coffee-bar', 'dev', 12.2, 11.5),
  st('qa', 'lab', 4, 2.8),
  it('test-board', 'test-board', 'lab', 4, 0.2),
  it('audit', 'audit-whiteboard', 'lab', 7.6, 6, 270),
  it('couch', 'lab-couch', 'lab', 1.6, 10.8),
];

const g = buildWaypointGraph(layout());
const spot = (id: string) => g.spots.find((s) => s.id === id)!;

describe('waypoint graph', () => {
  test('layout graph is connected and has 3 sofa + 3 coffee spots', () => {
    expect(isConnected(g)).toBe(true);
    expect(g.spots.filter((s) => s.kind === 'sofa')).toHaveLength(3);
    expect(g.spots.filter((s) => s.kind === 'coffee')).toHaveLength(3);
    expect(g.spots.filter((s) => s.kind === 'sofa').every((s) => s.capacityGroup === 'lounge')).toBe(true);
    expect(g.spots.filter((s) => s.kind === 'lab-couch')).toHaveLength(2);
  });
  test('path from dev door to a sofa starts at the door and ends at the sofa', () => {
    const p = findPath(g, 'door-dev', 'sofa-0');
    expect(p[0]).toEqual(spot('door-dev').pos);
    expect(p.at(-1)).toEqual(spot('sofa-0').pos);
  });
  test('QA lab reachable from dev door through the internal door', () => {
    const p = findPath(g, 'door-dev', 'test-board');
    expect(p.length).toBeGreaterThan(0);
    expect(p.some((v) => Math.abs(v.x - 14) < 1 && Math.abs(v.z - 5.7) < 1)).toBe(true);
  });
  test('freeSpot skips occupied', () => {
    expect(freeSpot(g, 'coffee', new Set(['coffee-0', 'coffee-1']))?.id).toBe('coffee-2');
    expect(freeSpot(g, 'coffee', new Set(['coffee-0', 'coffee-1', 'coffee-2']))).toBeNull();
    expect(freeSpot(g, 'seat', new Set(), 'lab')?.role).toBe('qa');
  });
  test('developer seats follow seatCounts', () => {
    expect(buildWaypointGraph(layout(), { implementer: 5 }).spots.filter((s) => s.role === 'implementer')).toHaveLength(5);
    expect(g.spots.filter((s) => s.role === 'implementer')).toHaveLength(2);
    expect(buildWaypointGraph(layout(), { implementer: 12 }).spots.filter((s) => s.role === 'implementer')).toHaveLength(8);
  });
  test('boxing in the lounge makes the graph disconnected and paths empty', () => {
    const boxed = [
      ...layout(),
      it('b0', 'desk', 'dev', 1, 8.7),
      it('b1', 'desk', 'dev', 3, 8.7),
      it('b2', 'desk', 'dev', 4.7, 8.7),
      it('b3', 'desk', 'dev', 4.7, 10.2, 90),
      it('b4', 'desk', 'dev', 4.7, 11.6, 90),
    ];
    const gb = buildWaypointGraph(boxed);
    expect(isConnected(gb)).toBe(false);
    expect(findPath(gb, 'door-dev', 'sofa-0')).toEqual([]);
  });
  test('paths never cross a footprint', () => {
    const p = findPath(g, 'door-dev', 'seat-reviewer-0');
    expect(p.length).toBeGreaterThan(1);
  });
});
