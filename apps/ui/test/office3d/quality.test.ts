import { describe, expect, test } from 'vitest';
import { qualitySettings } from '../../src/office3d/scene/quality.ts';

describe('qualitySettings', () => {
  test('low: pixel ratio 1, no shadows, opaque tinted glass, no MSAA', () => {
    expect(qualitySettings('low')).toEqual({ dpr: 1, shadows: false, glassOpacity: null, antialias: false });
  });

  test('medium: pixel ratio 1, no shadows, transparent glass, no MSAA', () => {
    expect(qualitySettings('medium')).toEqual({ dpr: 1, shadows: false, glassOpacity: 0.15, antialias: false });
  });

  test('high: device pixel ratio, shadows, transparent glass, MSAA', () => {
    expect(qualitySettings('high', 2)).toEqual({ dpr: 2, shadows: true, glassOpacity: 0.15, antialias: true });
    expect(qualitySettings('high', 1.25).dpr).toBe(1.25);
  });

  test('high falls back to devicePixelRatio of 1 when none is known', () => {
    expect(qualitySettings('high', undefined).dpr).toBeGreaterThanOrEqual(1);
  });
});
