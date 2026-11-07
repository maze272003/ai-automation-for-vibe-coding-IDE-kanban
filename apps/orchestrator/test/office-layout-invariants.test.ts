import type { FurnitureItem } from '@aik/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { layoutInvariantErrors } from '../src/office/layout-invariants.ts';
import { OfficeRoomService } from '../src/office/room-service.ts';
import { createTestDb } from './helpers/db.ts';

const st = (role: NonNullable<FurnitureItem['role']>, area: 'dev' | 'lab', x: number, z: number): FurnitureItem => ({ id: `station-${role}`, kind: 'station', area, x, z, rotationY: 0, role });
const it2 = (id: string, kind: FurnitureItem['kind'], area: 'dev' | 'lab', x: number, z: number): FurnitureItem => ({ id, kind, area, x, z, rotationY: 0 });

/** Mirrors the renderer's defaultRoomLayout() (apps/ui/src/office3d/layout/room.ts). */
const valid = (): FurnitureItem[] => [
  st('planner', 'dev', 1.2, 3.5),
  st('implementer', 'dev', 4.4, 5),
  st('reviewer', 'dev', 9, 3.5),
  st('pm', 'dev', 11.6, 3.5),
  it2('lounge', 'reading-lounge', 'dev', 2.2, 10.5),
  it2('huddle', 'huddle', 'dev', 9.2, 9.6),
  it2('coffee', 'coffee-bar', 'dev', 12.2, 11.5),
  st('qa', 'lab', 4, 2.8),
  it2('test-board', 'test-board', 'lab', 4, 0.2),
  it2('audit', 'audit-whiteboard', 'lab', 7.6, 6),
  it2('couch', 'lab-couch', 'lab', 1.6, 10.8),
  it2('lab-plant', 'plant', 'lab', 7.4, 11.4),
];

describe('layoutInvariantErrors', () => {
  it('accepts the default layout and null (default) layouts', () => {
    expect(layoutInvariantErrors(valid())).toEqual([]);
    expect(layoutInvariantErrors(null)).toEqual([]);
  });

  it('rejects a station without a role', () => {
    const items = valid();
    const { role: _role, ...noRole } = items[0]!;
    items[0] = noRole;
    expect(layoutInvariantErrors(items).join('\n')).toMatch(/station-planner: station has no role/);
  });

  it('rejects missing and duplicated special items', () => {
    const missing = valid().filter((i) => i.kind !== 'coffee-bar');
    expect(layoutInvariantErrors(missing)).toContain('missing required item: coffee-bar');
    const dup = [...valid(), { ...st('qa', 'lab', 4, 8), id: 'qa2' }];
    expect(layoutInvariantErrors(dup).join('\n')).toMatch(/duplicate item: station:qa/);
  });

  it('rejects items outside their area bounds', () => {
    const items = valid().map((i) => (i.id === 'lab-plant' ? { ...i, x: 12 } : i));
    expect(layoutInvariantErrors(items).join('\n')).toMatch(/lab-plant: outside the lab room/);
    const neg = valid().map((i) => (i.id === 'lounge' ? { ...i, z: -1 } : i));
    expect(layoutInvariantErrors(neg).join('\n')).toMatch(/lounge: outside the dev room/);
  });
});

describe('OfficeRoomService.patch semantic validation', () => {
  let svc: OfficeRoomService;
  beforeEach(() => {
    svc = new OfficeRoomService({ db: createTestDb().db, bus: new EventBus() });
  });

  it('rejects a semantically invalid layout with 400 VALIDATION_FAILED and keeps the stored one', () => {
    const r = svc.onProjectCreated({ id: 1, key: 'ALPHA', name: 'Alpha', repoPath: 'C:/repos/alpha' });
    const bad = valid().filter((i) => i.kind !== 'huddle');
    expect(() => svc.patch(r.id, { customization: { ...r.customization, layout: bad } })).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED' }),
    );
    expect(svc.list({ includeArchived: false })[0]!.customization.layout).toBeNull();
    const ok = svc.patch(r.id, { customization: { ...r.customization, layout: valid() } });
    expect(ok.customization.layout).toHaveLength(12);
  });
});
