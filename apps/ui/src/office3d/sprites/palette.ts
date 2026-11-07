import type { StationRole } from '@aik/contracts';

/** Shirt colour (T) and its shade (t) per role. */
const SHIRTS: Record<StationRole, [string, string]> = {
  planner: ['#60a5fa', '#2563eb'],
  implementer: ['#f59e0b', '#b45309'],
  reviewer: ['#a78bfa', '#7c3aed'],
  qa: ['#22d3ee', '#0e7490'],
  pm: ['#4ade80', '#15803d'],
};

/** Hair (H), skin (S) and skin shade (s) presets; variant index wraps modulo 4. */
const LOOKS: Array<{ H: string; S: string; s: string }> = [
  { H: '#3f2a1d', S: '#e7c4a0', s: '#c9a07a' },
  { H: '#111827', S: '#8d5a3b', s: '#6f4429' },
  { H: '#b45309', S: '#f3d3b5', s: '#d6b08c' },
  { H: '#d1d5db', S: '#c68e65', s: '#a4724d' },
];

/**
 * Palette keys used by the sprite grids: H hair, S skin, s skin shade, E eye,
 * M mouth, T shirt, t shirt shade, P pants, B shoes, W white, K grey, C coffee,
 * G green, R red, Y yellow.
 */
export function rolePalette(role: StationRole, variant: number): Record<string, string> {
  const [T, t] = SHIRTS[role];
  const look = LOOKS[((Math.trunc(variant) % 4) + 4) % 4]!;
  return {
    ...look,
    E: '#0f172a',
    M: '#b45309',
    T,
    t,
    P: '#334155',
    B: '#0f172a',
    W: '#f8fafc',
    K: '#94a3b8',
    C: '#7c2d12',
    G: '#4ade80',
    R: '#f87171',
    Y: '#facc15',
  };
}
