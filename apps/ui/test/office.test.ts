// apps/ui/test/office.test.ts
import { describe, expect, test } from 'vitest';
import { isOfficeEnabled, parseOfficeLabel, toOfficeBounds } from '../src/lib/office.ts';

describe('office lib', () => {
  test('enabled only when the setting is explicitly true', () => {
    expect(isOfficeEnabled({ opencodeMode: 'managed', agentOffice: true })).toBe(true);
    expect(isOfficeEnabled({ opencodeMode: 'managed', agentOffice: false })).toBe(false);
    expect(isOfficeEnabled(null)).toBe(false);
  });

  test('bounds are rounded, never negative', () => {
    expect(toOfficeBounds({ x: 10.4, y: 20.6, width: 800.5, height: 600.2 })).toEqual({ x: 10, y: 21, width: 801, height: 600 });
    expect(toOfficeBounds({ x: -3, y: 0, width: 12.5, height: 0 })).toEqual({ x: 0, y: 0, width: 13, height: 0 });
  });
});

describe('parseOfficeLabel', () => {
  test('splits the office character label into storyKey + role', () => {
    expect(parseOfficeLabel('INV-7 planner')).toEqual({ storyKey: 'INV-7', role: 'planner' });
    expect(parseOfficeLabel('WT-12 implementer')).toEqual({ storyKey: 'WT-12', role: 'implementer' });
  });

  test('rejects labels without a space or with an empty part', () => {
    expect(parseOfficeLabel('INV-7')).toBeNull();
    expect(parseOfficeLabel('planner ')).toBeNull();
    expect(parseOfficeLabel('')).toBeNull();
    expect(parseOfficeLabel('INV-7 ')).toBeNull();
  });
});
