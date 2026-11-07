import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { flyDuration, flyPose, type CameraPose } from './fly.ts';

/** Near plane per view: close-up room vantage needs a small one; the overview keeps depth precision (floor inlays). */
export const NEAR_OVERVIEW = 1;
export const NEAR_CLOSE = 0.1;

type Flight = { from: CameraPose; to: CameraPose; start: number; dur: number };

const tuple = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];

/**
 * Overview / room camera (spec 6.6): three's MapControls (left-drag pan, wheel zoom, right-drag rotate) and an
 * eased fly-to whenever `poseKey` changes. Render on demand: MapControls 'change' requests one frame, a flight
 * requests a frame per animation step and stops when it lands, so an idle camera draws nothing.
 *
 * The first placement of a fresh camera snaps (opening the page); later pose changes fly, including the
 * return from walk mode (the walk camera's view is the start of the flight).
 */
export function OverviewControls({ pose, poseKey, close, flySpeed }: { pose: CameraPose; poseKey: string; close: boolean; flySpeed: number }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useMemo(() => new MapControls(camera, gl.domElement), [camera, gl]);
  const flight = useRef<Flight | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    controls.enableDamping = false; // damping would need a frame every tick
    controls.maxPolarAngle = Math.PI / 2 - 0.08; // never below the floor
    controls.minDistance = 1.5;
    controls.maxDistance = 400;
    const onChange = () => invalidate();
    controls.addEventListener('change', onChange);
    return () => {
      controls.removeEventListener('change', onChange);
      controls.dispose();
    };
  }, [controls, invalidate]);

  useEffect(() => {
    const near = close ? NEAR_CLOSE : NEAR_OVERVIEW;
    if (camera.near !== near) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const placed = camera.userData['officePlaced'] === true;
    camera.userData['officePlaced'] = true;
    if (!placed) {
      camera.position.set(...pose.position);
      controls.target.set(...pose.target);
      controls.update();
      mounted.current = true;
      invalidate();
      return;
    }
    // Start from the current view: the live MapControls target, or (first run after walk mode) a point
    // straight ahead at the destination's distance so the flight starts without a jump.
    let fromTarget: Vector3;
    if (mounted.current) fromTarget = controls.target.clone();
    else {
      const dir = new Vector3();
      camera.getWorldDirection(dir);
      const d = camera.position.distanceTo(new Vector3(...pose.target)) || 10;
      fromTarget = camera.position.clone().addScaledVector(dir, d);
    }
    mounted.current = true;
    flight.current = { from: { position: tuple(camera.position), target: tuple(fromTarget) }, to: pose, start: performance.now(), dur: flyDuration(flySpeed) };
    controls.enabled = false;
    invalidate();
    // `poseKey` identifies the destination; the pose object itself is rebuilt on every render.
  }, [poseKey]);

  useFrame(() => {
    const f = flight.current;
    if (!f) return;
    const t = f.dur > 0 ? (performance.now() - f.start) / f.dur : 1;
    const p = flyPose(f.from, f.to, t);
    camera.position.set(...p.position);
    controls.target.set(...p.target);
    camera.lookAt(controls.target);
    if (t >= 1) {
      flight.current = null;
      controls.enabled = true;
      controls.update(); // dispatches 'change' -> one more frame with the final pose
    } else invalidate();
  });

  return null;
}
