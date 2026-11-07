import { SPECIAL_KINDS, STATION_ROLES, type FurnitureItem } from '@aik/contracts';

/** Suite area sizes in metres (mirror apps/ui/src/office3d/layout/dimensions.ts). */
const AREA_LENGTH = { dev: 14, lab: 8 } as const;
const SLOT_DEPTH = 12;

const REQUIRED = [
  ...STATION_ROLES.map((r) => `station:${r}`),
  ...SPECIAL_KINDS.filter((k) => k !== 'station'),
];

/**
 * Minimal semantic invariants for a stored room layout (the renderer's validateLayout is the full check):
 * every station has a role, each station role and special item appears exactly once, and every item's
 * position lies inside its area. `null` means "use the default layout" and is always valid.
 */
export function layoutInvariantErrors(items: FurnitureItem[] | null): string[] {
  if (items === null) return [];
  const errors: string[] = [];
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.kind === 'station' && !i.role) errors.push(`${i.id}: station has no role`);
    const len = AREA_LENGTH[i.area];
    if (!(i.x >= 0 && i.x <= len && i.z >= 0 && i.z <= SLOT_DEPTH)) errors.push(`${i.id}: outside the ${i.area} room`);
    const key = i.kind === 'station' ? (i.role ? `station:${i.role}` : null) : i.kind;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const key of REQUIRED) {
    const n = counts.get(key) ?? 0;
    if (n === 0) errors.push(`missing required item: ${key}`);
    else if (n > 1) errors.push(`duplicate item: ${key} (${n}, expected exactly 1)`);
  }
  return errors;
}
