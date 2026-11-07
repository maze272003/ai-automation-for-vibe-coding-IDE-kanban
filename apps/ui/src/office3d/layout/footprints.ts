import type { FurnitureItem, StationRole } from '@aik/contracts';

export type FootprintKey = Exclude<FurnitureItem['kind'], 'station'> | `station:${StationRole}`;

/** Axis-aligned footprint (w along x, d along z at rotationY 0), in metres. */
export const FOOTPRINTS: Record<FootprintKey, { w: number; d: number }> = {
  desk: { w: 2, d: 1 },
  chair: { w: 0.6, d: 0.6 },
  sofa: { w: 2.2, d: 0.9 },
  plant: { w: 0.5, d: 0.5 },
  'huddle-table': { w: 1.4, d: 1.4 },
  whiteboard: { w: 1.8, d: 0.2 },
  bookshelf: { w: 1.2, d: 0.4 },
  lamp: { w: 0.4, d: 0.4 },
  rug: { w: 2, d: 1.4 },
  'station:planner': { w: 2.4, d: 2 },
  // The reserved 2 x 4 developer zone (up to 8 desks); its footprint never changes.
  'station:implementer': { w: 4, d: 8 },
  'station:reviewer': { w: 2.4, d: 2 },
  'station:pm': { w: 2.4, d: 2 },
  'station:qa': { w: 2.4, d: 2 },
  'reading-lounge': { w: 4, d: 2.6 },
  'coffee-bar': { w: 3.6, d: 0.9 },
  huddle: { w: 2.8, d: 2.2 },
  'test-board': { w: 5.4, d: 0.3 },
  'audit-whiteboard': { w: 2.7, d: 0.6 },
  'lab-couch': { w: 2.8, d: 1 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Desks shown in the developer zone: max(2, active runs) capped at 8; extra runs are overflow ("+N"). */
export function devZoneSeats(activeDevs: number): { seats: number; overflow: number } {
  return { seats: clamp(Math.max(2, activeDevs), 2, 8), overflow: Math.max(0, activeDevs - 8) };
}
