import { useLayoutEffect, useRef } from 'react';
import { Color, Euler, Matrix4, Quaternion, Vector3, type InstancedMesh } from 'three';
import { useThree } from '@react-three/fiber';

/** Capacity buckets so an InstancedMesh is recreated only when it outgrows its buffer, not on every change. */
export function capacityFor(n: number): number {
  let c = 16;
  while (c < n) c *= 2;
  return c;
}

export type InstanceSpec = { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; color: string };

const m4 = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const euler = new Euler();
const scl = new Vector3();
const col = new Color();

/**
 * Writes instance matrices/colours whenever `specs` changes, then requests one frame (render-on-demand).
 * Returns the ref to attach to the `<instancedMesh>`.
 */
export function useInstances(specs: InstanceSpec[], capacity: number) {
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    specs.forEach((s, i) => {
      pos.set(s.x, s.y, s.z);
      quat.setFromEuler(euler.set(0, s.yaw, 0));
      scl.set(s.sx, s.sy, s.sz);
      mesh.setMatrixAt(i, m4.compose(pos, quat, scl));
      mesh.setColorAt(i, col.set(s.color));
    });
    mesh.count = specs.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    invalidate();
  }, [specs, capacity, invalidate]);
  return ref;
}

/**
 * A stable function identity that always calls the latest `fn`. Event-handler props on three objects must
 * keep their identity: React Three Fiber treats a new handler as a prop change and requests a frame.
 */
export function useStableHandler<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const latest = useRef(fn);
  latest.current = fn;
  const stable = useRef((...args: A) => latest.current(...args));
  return stable.current;
}
