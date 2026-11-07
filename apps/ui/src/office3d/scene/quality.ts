import type { OFFICE_QUALITY } from '@aik/contracts';

export type OfficeQuality = (typeof OFFICE_QUALITY)[number];

export type QualitySettings = {
  dpr: number;
  shadows: boolean;
  /** Glass opacity; null = opaque tinted glass (no transparency sorting/blending). */
  glassOpacity: number | null;
  antialias: boolean;
};

const deviceRatio = (): number => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/**
 * Render settings per quality level (spec §9). Pure: `devicePixelRatio` is injectable for tests and
 * defaults to the window's.
 */
export function qualitySettings(q: OfficeQuality, devicePixelRatio: number = deviceRatio()): QualitySettings {
  switch (q) {
    case 'low':
      return { dpr: 1, shadows: false, glassOpacity: null, antialias: false };
    case 'medium':
      return { dpr: 1, shadows: false, glassOpacity: 0.15, antialias: false };
    case 'high':
      return { dpr: devicePixelRatio > 0 ? devicePixelRatio : 1, shadows: true, glassOpacity: 0.15, antialias: true };
  }
}
