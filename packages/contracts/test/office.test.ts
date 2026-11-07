import { describe, expect, test } from 'vitest';
import {
  ACCENT_PALETTE, DEFAULT_OFFICE_PREFERENCES, EVENT_TOPICS, FurnitureItem, RoomCustomization,
  defaultAccent, parseOfficePreferences, slotAt, slotKey,
} from '../src/index.ts';

describe('office contracts', () => {
  test('slotAt follows round-robin wings, left before right, nearest first', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => slotKey(slotAt(n)))).toEqual(
      ['N:0:L', 'E:0:L', 'S:0:L', 'W:0:L', 'N:0:R', 'E:0:R', 'S:0:R', 'W:0:R', 'N:1:L']);
    expect(slotKey(slotAt(19))).toBe('W:2:L');
  });
  test('defaultAccent is deterministic and from the palette', () => {
    expect(defaultAccent('ALPHA')).toBe(defaultAccent('ALPHA'));
    expect(ACCENT_PALETTE).toContain(defaultAccent('BETA'));
  });
  test('parseOfficePreferences falls back per field and never throws', () => {
    expect(parseOfficePreferences(undefined)).toEqual(DEFAULT_OFFICE_PREFERENCES);
    expect(parseOfficePreferences({ quality: 'ultra', walkSpeed: 2 })).toEqual({ ...DEFAULT_OFFICE_PREFERENCES, walkSpeed: 2 });
    expect(parseOfficePreferences('garbage')).toEqual(DEFAULT_OFFICE_PREFERENCES);
  });
  test('RoomCustomization rejects bad colour and unknown keys', () => {
    const ok = { signName: null, accentColor: '#f59e0b', icon: null, screens: null, layout: null };
    expect(RoomCustomization.safeParse(ok).success).toBe(true);
    expect(RoomCustomization.safeParse({ ...ok, accentColor: 'red' }).success).toBe(false);
    expect(RoomCustomization.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  test('FurnitureItem rotation must be a multiple of 15', () => {
    const base = { id: 'd1', kind: 'desk', area: 'dev', x: 1, z: 1, rotationY: 90 };
    expect(FurnitureItem.safeParse(base).success).toBe(true);
    expect(FurnitureItem.safeParse({ ...base, rotationY: 10 }).success).toBe(false);
  });
  test('office.rooms_changed is an event topic', () => { expect(EVENT_TOPICS).toContain('office.rooms_changed'); });
});
