import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Frustum, Matrix4, type Box3, type Camera } from 'three';
import { dataSignature } from '../screens/data.ts';
import type { Ctx2D } from '../screens/pixel-font.ts';
import { pixelCanvasTexture } from './materials.ts';

/** Screens repaint at most once per second (spec §9). */
export const SCREEN_MIN_INTERVAL_MS = 1000;

const frustum = new Frustum();
const viewProj = new Matrix4();

export function inView(camera: Camera, box: Box3): boolean {
  camera.updateMatrixWorld();
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return frustum.setFromProjectionMatrix(viewProj).intersectsBox(box);
}

export type ScreenProps<T> = {
  data: T;
  paint: (ctx: Ctx2D, data: T, w: number, h: number) => void;
  /** Canvas size in pixels (pixel-art resolution). */
  px: [number, number];
  /** Plane size in metres. */
  size: [number, number];
  position: [number, number, number];
  yaw: number;
  /** World bounds of the owning suite: off-screen suites defer repaints until they come into view. */
  bounds?: Box3;
  dim?: boolean;
};

/**
 * A pixel screen: one CanvasTexture, repainted only when `dataSignature(data)` changes, at most 1x/s, and
 * only while its suite is inside the camera frustum (a deferred repaint runs on the next rendered frame
 * that sees it, e.g. after the camera moves).
 */
export function Screen<T>({ data, paint, px, size, position, yaw, bounds, dim = false }: ScreenProps<T>) {
  const [pw, ph] = px;
  const { ctx, texture } = useMemo(() => pixelCanvasTexture(pw, ph), [pw, ph]);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const sig = dataSignature(data);
  const st = useRef({ painted: '', wanted: sig, data, last: -Infinity, timer: 0 as ReturnType<typeof setTimeout> | 0 });
  st.current.wanted = sig;
  st.current.data = data;

  /** Paint if due; returns true when the texture changed. */
  const tryPaint = useRef<(force: boolean) => boolean>(() => false);
  tryPaint.current = (force: boolean) => {
    const s = st.current;
    if (s.painted === s.wanted) return false;
    if (!force && bounds && !inView(get().camera, bounds)) return false;
    const now = performance.now();
    const wait = s.last + SCREEN_MIN_INTERVAL_MS - now;
    if (!force && wait > 0) {
      if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = 0;
          if (tryPaint.current(false)) invalidate();
        }, wait);
      }
      return false;
    }
    paint(ctx, s.data, pw, ph);
    texture.needsUpdate = true;
    s.painted = s.wanted;
    s.last = now;
    return true;
  };

  useEffect(() => {
    // First paint is unconditional so no screen starts blank; later ones obey the throttle + frustum.
    if (tryPaint.current(st.current.painted === '')) invalidate();
  }, [sig, invalidate]);

  useFrame(() => {
    if (st.current.painted !== st.current.wanted) tryPaint.current(false);
  });

  useEffect(
    () => () => {
      if (st.current.timer) clearTimeout(st.current.timer);
      texture.dispose();
    },
    [texture],
  );

  return (
    <mesh position={position} rotation={[0, yaw, 0]}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={texture} toneMapped={false} color={dim ? '#555555' : '#ffffff'} />
    </mesh>
  );
}
