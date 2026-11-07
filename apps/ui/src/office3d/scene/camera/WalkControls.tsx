import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { isEditableTarget } from '../../../lib/shortcuts.ts';
import { resolveMove, type Segment } from './collision.ts';
import type { CameraPose } from './fly.ts';

const NEAR_WALK = 0.05;
const MAX_DT = 0.1;

const KEYS: Record<string, 'f' | 'b' | 'l' | 'r'> = {
  KeyW: 'f',
  ArrowUp: 'f',
  KeyS: 'b',
  ArrowDown: 'b',
  KeyA: 'l',
  ArrowLeft: 'l',
  KeyD: 'r',
  ArrowRight: 'r',
};

/**
 * First-person walk mode (spec 6.6): PointerLockControls for mouse look (sensitivity from prefs), WASD /
 * arrow keys to move at `walkSpeed` m/s, collision against the layout's wall segments (collision.ts).
 * Pointer lock is requested on entry and on a click on the canvas; leaving pointer lock (Esc) exits to the
 * overview via `onExit`. Frames are requested only while moving or looking around.
 *
 * `start` is read once on mount; later prop changes (e.g. a room clicked while walking) do not teleport.
 */
export function WalkControls({
  start, segments, walkSpeed, mouseSensitivity, onExit,
}: {
  start: CameraPose;
  segments: Segment[];
  walkSpeed: number;
  mouseSensitivity: number;
  onExit(): void;
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const pressed = useRef(new Set<'f' | 'b' | 'l' | 'r'>());
  // True for the first frame after starting to move: the frame clock's delta then spans the idle time.
  const fresh = useRef(false);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const startRef = useRef(start);

  useEffect(() => {
    const s = startRef.current;
    camera.position.set(...s.position);
    camera.lookAt(...s.target);
    camera.near = NEAR_WALK;
    camera.updateProjectionMatrix();
    camera.userData['officePlaced'] = true;
    invalidate();
  }, [camera, invalidate]);

  useEffect(() => {
    const el = gl.domElement;
    const controls = new PointerLockControls(camera, el);
    // three logs a console error when pointer lock is refused (no user gesture, e.g. defaultView 'walk' on
    // open); that is expected here - the user can click the canvas to lock - so drop its error listener.
    const internal = controls as unknown as { _onPointerlockError?: EventListener };
    if (internal._onPointerlockError) el.ownerDocument.removeEventListener('pointerlockerror', internal._onPointerlockError);
    controls.pointerSpeed = mouseSensitivity;
    let wasLocked = false;
    const onChange = () => invalidate();
    const onLock = () => {
      wasLocked = true;
    };
    const onUnlock = () => {
      if (wasLocked) exitRef.current();
    };
    controls.addEventListener('change', onChange);
    controls.addEventListener('lock', onLock);
    controls.addEventListener('unlock', onUnlock);
    const lock = () => {
      if (el.ownerDocument.pointerLockElement === el) return;
      try {
        // Chromium returns a promise that rejects without a user gesture; swallow it (click to retry).
        void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
      } catch {
        // Pointer lock unavailable: walking with the keys still works.
      }
    };
    lock();
    el.addEventListener('click', lock);
    return () => {
      el.removeEventListener('click', lock);
      controls.removeEventListener('unlock', onUnlock);
      controls.removeEventListener('lock', onLock);
      controls.removeEventListener('change', onChange);
      if (el.ownerDocument.pointerLockElement === el) controls.unlock();
      controls.dispose();
    };
  }, [camera, gl, invalidate, mouseSensitivity]);

  useEffect(() => {
    const keys = pressed.current;
    const down = (e: KeyboardEvent) => {
      const k = KEYS[e.code];
      if (!k || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      e.preventDefault();
      if (keys.size === 0) fresh.current = true;
      keys.add(k);
      invalidate();
    };
    const up = (e: KeyboardEvent) => {
      const k = KEYS[e.code];
      if (k) keys.delete(k);
    };
    const clear = () => keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      keys.clear();
    };
  }, [invalidate]);

  const fwd = useRef(new Vector3());
  useFrame((_, delta) => {
    const keys = pressed.current;
    if (keys.size === 0) return;
    const f = (keys.has('f') ? 1 : 0) - (keys.has('b') ? 1 : 0);
    const r = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
    if (f !== 0 || r !== 0) {
      const dir = camera.getWorldDirection(fwd.current);
      const len = Math.hypot(dir.x, dir.z) || 1;
      const fx = dir.x / len;
      const fz = dir.z / len;
      // Right of the forward vector on the floor plane (y up): (-fz, fx).
      let mx = fx * f - fz * r;
      let mz = fz * f + fx * r;
      const ml = Math.hypot(mx, mz) || 1;
      const step = walkSpeed * (fresh.current ? 1 / 60 : Math.min(delta, MAX_DT));
      mx = (mx / ml) * step;
      mz = (mz / ml) * step;
      const next = resolveMove({ x: camera.position.x, z: camera.position.z }, { x: mx, z: mz }, segments);
      camera.position.x = next.x;
      camera.position.z = next.z;
    }
    fresh.current = false;
    invalidate();
  });

  return null;
}
