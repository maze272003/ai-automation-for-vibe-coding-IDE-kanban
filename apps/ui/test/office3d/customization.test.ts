import { DEFAULT_OFFICE_PREFERENCES, ROOM_ICONS, STATION_STATES, type OfficePreferences, type RoomCustomization } from '@aik/contracts';
import { describe, expect, test } from 'vitest';
import { STATE_COLOR } from '../../src/office3d/screens/paint.ts';
import { effectiveMovement, effectiveScreens, effectiveStatusColor } from '../../src/office3d/state/customization.ts';
import { ROOM_ICON_GRIDS } from '../../src/office3d/ui/icons.ts';

const room = (screens: RoomCustomization['screens']): RoomCustomization => ({ signName: null, accentColor: '#22d3ee', icon: null, screens, layout: null });
const prefs = (p: Partial<OfficePreferences>): OfficePreferences => ({ ...DEFAULT_OFFICE_PREFERENCES, ...p });

describe('effectiveScreens', () => {
  test('room override wins, otherwise the global default', () => {
    const global = prefs({ screens: { kanban: true, activity: false, runs: true } });
    expect(effectiveScreens(room(null), global)).toEqual({ kanban: true, activity: false, runs: true });
    expect(effectiveScreens(room({ kanban: false, activity: true, runs: false }), global)).toEqual({ kanban: false, activity: true, runs: false });
  });
});

describe('effectiveStatusColor', () => {
  test('user colour wins, otherwise the built-in state colour', () => {
    expect(effectiveStatusColor('working', prefs({ statusColors: { working: '#112233' } }))).toBe('#112233');
    expect(effectiveStatusColor('idle', prefs({ statusColors: { working: '#112233' } }))).toBe(STATE_COLOR.idle);
    for (const s of STATION_STATES) expect(effectiveStatusColor(s, DEFAULT_OFFICE_PREFERENCES)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('effectiveMovement', () => {
  test('low quality forces desk unless the user chose off', () => {
    expect(effectiveMovement(prefs({ quality: 'low', agentMovement: 'full' }))).toBe('desk');
    expect(effectiveMovement(prefs({ quality: 'low', agentMovement: 'off' }))).toBe('off');
    expect(effectiveMovement(prefs({ quality: 'low', agentMovement: 'desk' }))).toBe('desk');
    expect(effectiveMovement(prefs({ quality: 'high', agentMovement: 'full' }))).toBe('full');
    expect(effectiveMovement(prefs({ quality: 'medium', agentMovement: 'desk' }))).toBe('desk');
  });
});

describe('ROOM_ICON_GRIDS', () => {
  test('one 8x8 grid per icon, with some set pixels, all distinct', () => {
    expect(Object.keys(ROOM_ICON_GRIDS).sort()).toEqual([...ROOM_ICONS].sort());
    const seen = new Set<string>();
    for (const icon of ROOM_ICONS) {
      const g = ROOM_ICON_GRIDS[icon];
      expect(g).toHaveLength(8);
      for (const row of g) expect(row).toMatch(/^[.#]{8}$/);
      expect(g.join('').includes('#')).toBe(true);
      seen.add(g.join(''));
    }
    expect(seen.size).toBe(ROOM_ICONS.length);
  });
});
