import { describe, expect, test } from 'vitest';
import { DEFAULT_OFFICE_PREFERENCES, slotAt, type EventEnvelope, type OfficeRoomDTO } from '@aik/contracts';
import { defaultRoomLayout } from '../../src/office3d/layout/room.ts';
import { contains } from '../../src/office3d/layout/geometry.ts';
import { emptyOfficeState, type OfficeState } from '../../src/office3d/state/model.ts';
import { reduceOffice } from '../../src/office3d/state/reduce.ts';
import { sceneModel } from '../../src/office3d/scene/derive.ts';
import { hubPlacements } from '../../src/office3d/scene/hub.ts';
import { placeItem } from '../../src/office3d/scene/place.ts';
import { itemParts, stationSeatOffsets } from '../../src/office3d/scene/props.ts';
import { ringSpecs } from '../../src/office3d/scene/StatusRings.tsx';
import { emptyStructure, shellStructure, suiteStructure } from '../../src/office3d/scene/structure.ts';
import { suiteFrame } from '../../src/office3d/scene/transform.ts';

const T = 1_000_000;
const room = (id: number, patch: Partial<OfficeRoomDTO> = {}): OfficeRoomDTO => ({
  id, state: 'active', projectId: id, projectKey: `P${id}`, projectName: `P${id}`, projectStatus: 'active', slot: slotAt(id - 1),
  customization: { signName: null, accentColor: '#f59e0b', icon: null, screens: null, layout: null },
  createdAt: 0, updatedAt: 0, archivedAt: null, ...patch,
});
const withRooms = (rooms: OfficeRoomDTO[]): OfficeState => reduceOffice(emptyOfficeState(), { type: 'rooms', rooms }, T);
const prefs = DEFAULT_OFFICE_PREFERENCES;

describe('scene model', () => {
  test('archived rooms are hidden unless showArchived, then dimmed; unavailable rooms dimmed', () => {
    const s = withRooms([room(1), room(2, { state: 'archived', projectStatus: 'archived' }), room(3, { projectStatus: 'unavailable' })]);
    const hidden = sceneModel(s, T, prefs);
    expect(hidden.suites.map((x) => x.roomId)).toEqual([1, 3]);
    expect(hidden.suites.find((x) => x.roomId === 3)!.dim).toBe('unavailable');
    // Hidden rooms still hold their slot, so the building does not shrink.
    expect(hidden.building.suites).toHaveLength(3);
    const shown = sceneModel(s, T, { ...prefs, showArchived: true });
    expect(shown.suites.find((x) => x.roomId === 2)!.dim).toBe('archived');
  });

  test('room screens fall back to the global toggles; default layout when none saved', () => {
    const s = withRooms([room(1), room(2, { customization: { signName: 'Lab', accentColor: '#60a5fa', icon: null, screens: { kanban: false, activity: true, runs: true }, layout: null } })]);
    const m = sceneModel(s, T, { ...prefs, screens: { kanban: true, activity: false, runs: true } });
    expect(m.suites[0]!.screens).toEqual({ kanban: true, activity: false, runs: true });
    expect(m.suites[1]!.screens.kanban).toBe(false);
    expect(m.suites[1]!.sign).toBe('LAB');
    expect(m.suites[0]!.layout).toEqual(defaultRoomLayout());
  });

  test('a running implementer colours its seat ring with the status override', () => {
    const ev: EventEnvelope = { seq: 1, topic: 'run.started', storyId: 7, at: T, provenance: 'system', data: { runId: 9, role: 'implementer', storyKey: 'P1-7', projectKey: 'P1' } };
    const s = reduceOffice(withRooms([room(1)]), { type: 'event', event: ev }, T);
    const m = sceneModel(s, T, prefs);
    expect(m.suites[0]!.seats.implementer[0]).toBe('working');
    const { specs, targets } = ringSpecs(m.suites, { working: '#123456' });
    const i = targets.findIndex((t) => t.role === 'implementer');
    expect(specs[i]!.color).toBe('#123456');
    expect(targets.filter((t) => t.role === 'implementer')).toHaveLength(2); // max(2, active) desks
  });
});

describe('props and structure', () => {
  test('every default-layout prop lands inside its suite (L and R sides)', () => {
    const m = sceneModel(withRooms([room(1), room(5)]), T, prefs);
    for (const sm of m.suites) {
      const f = suiteFrame(sm.suite);
      for (const item of sm.layout) {
        for (const p of placeItem(f, item, 1, { low: false, accent: sm.accent, dim: false })) {
          const r = item.area === 'dev' ? sm.suite.dev : sm.suite.lab;
          expect(contains(r, p), `${item.id} ${p.model}`).toBe(true);
        }
      }
    }
  });

  test('station desks follow the seat count; Low drops detail props', () => {
    const dev = defaultRoomLayout().find((i) => i.role === 'implementer')!;
    expect(itemParts(dev, 5).filter((p) => p.model === 'desk')).toHaveLength(5);
    expect(stationSeatOffsets('implementer', 12)).toHaveLength(8);
    expect(itemParts(dev, 2).some((p) => p.detail)).toBe(true);
    expect(hubPlacements(true).some((p) => p.model === 'keyboard' || p.model === 'mug')).toBe(false);
  });

  test('suite floors carry the room id; empty slots get hallway walls', () => {
    const m = sceneModel(withRooms([room(1)]), T, prefs);
    const s = emptyStructure();
    shellStructure(s, m.building, m.visibleSlots);
    const before = s.solid.length;
    suiteStructure(s, m.suites[0]!.suite, { roomId: 1, dim: false, accent: '#f59e0b' });
    expect(s.floors.filter((f) => f.roomId === 1)).toHaveLength(3);
    expect(s.solid.length).toBeGreaterThan(before);
    expect(s.glass.length).toBeGreaterThan(0);
  });
});
