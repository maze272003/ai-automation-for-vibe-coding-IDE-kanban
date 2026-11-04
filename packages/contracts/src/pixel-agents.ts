// packages/contracts/src/pixel-agents.ts — the bundled Pixel Agents office runtime (spec 2026-11-04).
/** Exact version of the `pixel-agents` npm package the app bundles as a runtime asset. */
export const PIXEL_AGENTS_PIN = '1.5.0';

/** How to reach a running Pixel Agents office server. `token` is a secret: redact, never log. */
export interface OfficeConfig {
  url: string;
  token: string;
}

/** Pixel-coordinate rectangle of the office viewport inside the window (CSS px == DIP at zoom 1). */
export interface OfficeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
