import { memo, useLayoutEffect, useRef } from 'react';
import type { DirectionalLight } from 'three';
import type { Rect } from '../layout/geometry.ts';

/**
 * Baked-feel lighting (spec §6.1): soft sky/ground fill + one directional "sun" through the windows.
 * Shadows only at High quality; the shadow camera is fitted to the building bounds.
 */
export const Lighting = memo(function Lighting({ x0, z0, x1, z1, shadows }: Rect & { shadows: boolean }) {
  const bounds = { x0, z0, x1, z1 };
  const sun = useRef<DirectionalLight>(null);
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cz = (bounds.z0 + bounds.z1) / 2;
  const half = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) / 2 + 4;

  useLayoutEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.target.position.set(cx, 0, cz);
    l.target.updateMatrixWorld();
    const c = l.shadow.camera;
    c.left = -half;
    c.right = half;
    c.top = half;
    c.bottom = -half;
    c.near = 1;
    c.far = half * 4;
    c.updateProjectionMatrix();
  }, [cx, cz, half, shadows]);

  return (
    <>
      <hemisphereLight args={['#dbe7ff', '#1b2333', 1.6]} />
      <ambientLight intensity={0.55} />
      <directionalLight
        ref={sun}
        position={[cx - half * 0.8, half * 1.4, cz + half * 0.5]}
        intensity={1.6}
        color="#fff4e0"
        castShadow={shadows}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.03}
      />
    </>
  );
});
