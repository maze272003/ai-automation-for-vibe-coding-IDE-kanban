import type { SuiteLayout } from '../../layout/building.ts';
import { DEV_LENGTH, SLOT_DEPTH } from '../../layout/dimensions.ts';
import type { Rect } from '../../layout/geometry.ts';
import { roomToWorld, suiteFrame } from '../transform.ts';

/** A camera placement: eye position and look-at target, world metres (y up). */
export type CameraPose = { position: [number, number, number]; target: [number, number, number] };

/** Base duration of a fly-to (spec 6.6: ~0.8 s); the effective duration is FLY_MS / flySpeed. */
export const FLY_MS = 800;

export function flyDuration(flySpeed: number): number {
  return FLY_MS / (flySpeed > 0 ? flySpeed : 1);
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const lerp3 = (a: readonly number[], b: readonly number[], k: number): [number, number, number] => [
  a[0]! + (b[0]! - a[0]!) * k,
  a[1]! + (b[1]! - a[1]!) * k,
  a[2]! + (b[2]! - a[2]!) * k,
];

/** Pose at progress `t` (clamped to 0..1) of a fly from `from` to `to`, ease-in-out cubic. The endpoints are exact. */
export function flyPose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  const c = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 1));
  if (c === 0) return { position: [...from.position], target: [...from.target] };
  if (c === 1) return { position: [...to.position], target: [...to.target] };
  const k = easeInOutCubic(c);
  return { position: lerp3(from.position, to.position, k), target: lerp3(from.target, to.target, k) };
}

/** Overview yaw/pitch (radians): looking down at the building from the south-east, as the Task 16 camera did. */
const OVERVIEW_YAW = Math.PI / 4;
const OVERVIEW_PITCH = 0.95;

/** Map camera above the building, looking at the centre of `bounds`, far enough to frame them. */
export function overviewPose(bounds: Rect): CameraPose {
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cz = (bounds.z0 + bounds.z1) / 2;
  const extent = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
  const dist = Math.max(40, extent * 0.95);
  const h = dist * Math.sin(OVERVIEW_PITCH);
  const r = dist * Math.cos(OVERVIEW_PITCH);
  return {
    position: [cx + r * Math.sin(OVERVIEW_YAW), h, cz + r * Math.cos(OVERVIEW_YAW)],
    target: [cx, 0, cz],
  };
}

/** Eye height of the room vantage and of walk mode. */
export const ROOM_EYE_Y = 2.4;
export const WALK_EYE_Y = 1.6;

/** Room vantage (room-local): just inside the dev door on the walkway, which the editor keeps clear. */
export const ROOM_VANTAGE = { x: DEV_LENGTH / 2, z: SLOT_DEPTH - 1.2 } as const;

/**
 * Fixed vantage inside a suite's dev room: near the door, slightly raised, looking at the back wall (the
 * Kanban / activity screens). Mapped through the suite frame, so mirrored right-side suites are correct.
 */
export function roomPose(suite: SuiteLayout): CameraPose {
  const f = suiteFrame(suite);
  const eye = roomToWorld(f, 'dev', ROOM_VANTAGE.x, ROOM_VANTAGE.z);
  const look = roomToWorld(f, 'dev', ROOM_VANTAGE.x, 0.5);
  return { position: [eye.x, ROOM_EYE_Y, eye.z], target: [look.x, 1.5, look.z] };
}

/** Hub start for walk mode when no room is selected: south of the reception axis, looking north. */
const HUB_WALK_START: CameraPose = { position: [0, WALK_EYE_Y, 14], target: [0, WALK_EYE_Y, 0] };

/** Where walk mode starts: inside the selected suite at the room vantage (eye height), else in the hub. */
export function walkStartPose(suite: SuiteLayout | null): CameraPose {
  if (!suite) return { position: [...HUB_WALK_START.position], target: [...HUB_WALK_START.target] };
  const f = suiteFrame(suite);
  const eye = roomToWorld(f, 'dev', ROOM_VANTAGE.x, ROOM_VANTAGE.z);
  const look = roomToWorld(f, 'dev', ROOM_VANTAGE.x, 0.5);
  return { position: [eye.x, WALK_EYE_Y, eye.z], target: [look.x, WALK_EYE_Y, look.z] };
}
