import type { StationRole } from '@aik/contracts';
import type { Vec2 } from '../layout/geometry.ts';
import type { SpotKind } from '../layout/waypoints.ts';
import { SPRITE_FRAMES } from '../sprites/sheets.ts';
import type { FigureState } from '../state/figures.ts';

/** Pure pose logic for the agent sprites (no three.js): which frame, which facing, how far to drop the quad. */

export type FrameName = keyof typeof SPRITE_FRAMES;
/** Facing relative to the camera: front = walking toward it, back = away, left/right = across the screen. */
export type Facing = 'front' | 'back' | 'left' | 'right';

/** Walk frames advance every this many metres walked (≈ 4 frames per 1.4 m stride cycle). */
export const WALK_STRIDE_M = 0.35;
/** Seated/gesture animations alternate two frames at this period (driven by the 2 Hz `now` tick). */
export const POSE_PERIOD_MS = 500;

const WALK: FrameName[] = ['walk-0', 'walk-1', 'walk-2', 'walk-3'];

/** Transparent rows at the bottom of a frame: seated frames are padded, the sprite is dropped by this much. */
export function padRows(frame: FrameName): number {
  const rows = SPRITE_FRAMES[frame];
  let n = 0;
  for (let j = rows.length - 1; j >= 0 && /^\.+$/.test(rows[j]!); j--) n++;
  return n;
}

/**
 * Frame for a figure. `spotKind` is the kind of the spot the figure is at (or heading to); `walked` is the
 * distance walked so far (walk cycle); `nowMs` drives two-frame pose animations.
 * Returns the frame and whether it animates over time while stationary (so the caller knows a 2 Hz repaint
 * is needed).
 */
export function figureFrame(
  f: Pick<FigureState, 'path' | 'activity' | 'leaving'>,
  spotKind: SpotKind | null,
  walked: number,
  nowMs: number,
): { frame: FrameName; animated: boolean } {
  if (f.path.length > 0) return { frame: WALK[Math.floor(walked / WALK_STRIDE_M) % 4]!, animated: false };
  const alt = Math.floor(nowMs / POSE_PERIOD_MS) % 2;
  if (f.activity === 'qa-passed') return { frame: 'thumbs-up', animated: false };
  if (f.leaving) return { frame: 'idle', animated: false };
  switch (spotKind) {
    case 'sofa':
    case 'lab-couch':
      return { frame: 'sit-read', animated: false };
    case 'coffee':
      return { frame: 'sip', animated: false };
    case 'huddle':
      return { frame: alt ? 'touch' : 'idle', animated: true };
    case 'test-board':
      return { frame: 'touch', animated: false };
    case 'whiteboard':
      return { frame: alt ? 'write-1' : 'write-0', animated: true };
    case 'seat':
      // Full spots fall back to the desk: reading is still shown as reading there.
      if (f.activity === 'reading') return { frame: 'sit-read', animated: false };
      return { frame: alt ? 'sit-type-1' : 'sit-type-0', animated: true };
    default:
      return { frame: 'idle', animated: false };
  }
}

/**
 * Facing from a world-space movement direction and the camera's horizontal right/forward unit vectors.
 * Walking toward the camera shows the front, away from it the back, across the screen a side.
 */
export function facingFor(dir: Vec2, camRight: Vec2, camForward: Vec2): Facing {
  const across = dir.x * camRight.x + dir.z * camRight.z;
  const along = dir.x * camForward.x + dir.z * camForward.z;
  if (Math.abs(across) === 0 && Math.abs(along) === 0) return 'front';
  if (Math.abs(across) > Math.abs(along)) return across > 0 ? 'right' : 'left';
  return along > 0 ? 'back' : 'front';
}

/** Sheet variant: only developers get the per-run hair/skin variation (spec 6.5a); one sheet per other role. */
export function sheetVariant(role: StationRole, variant: number): number {
  return role === 'implementer' ? ((Math.trunc(variant) % 4) + 4) % 4 : 0;
}

/** Bubble text as painted: the pixel font is upper-case only. Empty means no bubble. */
export function bubbleText(text: string): string {
  return text.trim().toUpperCase();
}
