import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Rect } from '../layout/geometry.ts';

/**
 * Minimal overview camera (placeholder until Task 18's MapControls / fly-to / walk mode): orbits a target
 * with left-drag, pans with right-drag or Shift+drag, zooms with the wheel; focuses the selected suite.
 * Every camera change requests exactly one frame (render-on-demand).
 */
export function BasicCamera({ bounds, focus }: { bounds: Rect; focus: Rect | null }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const view = useRef({ tx: 0, tz: 0, dist: 80, yaw: Math.PI / 4, pitch: 0.95 });

  const apply = useRef(() => {});
  apply.current = () => {
    const v = view.current;
    const h = v.dist * Math.sin(v.pitch);
    const r = v.dist * Math.cos(v.pitch);
    camera.position.set(v.tx + r * Math.sin(v.yaw), h, v.tz + r * Math.cos(v.yaw));
    camera.lookAt(v.tx, 0, v.tz);
    camera.updateMatrixWorld();
    invalidate();
  };

  // Frame the building, or the selected suite.
  const key = focus ? `${focus.x0},${focus.z0},${focus.x1},${focus.z1}` : `b:${bounds.x0},${bounds.z0},${bounds.x1},${bounds.z1}`;
  useEffect(() => {
    const r = focus ?? bounds;
    const v = view.current;
    v.tx = (r.x0 + r.x1) / 2;
    v.tz = (r.z0 + r.z1) / 2;
    const extent = Math.max(r.x1 - r.x0, r.z1 - r.z0);
    v.dist = focus ? Math.max(24, extent * 1.4) : Math.max(40, extent * 0.95);
    apply.current();
    // `key` encodes the rect values, so this reruns only when the framed rect changes.
  }, [key]);

  useEffect(() => {
    const el = gl.domElement;
    let drag: { x: number; y: number; pan: boolean } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const v = view.current;
      if (drag.pan) {
        const k = v.dist / Math.max(200, el.clientHeight);
        const sin = Math.sin(v.yaw);
        const cos = Math.cos(v.yaw);
        v.tx += (-dx * cos - dy * sin) * k * 1.6;
        v.tz += (dx * sin - dy * cos) * k * 1.6;
      } else {
        v.yaw -= dx * 0.005;
        v.pitch = Math.min(1.45, Math.max(0.25, v.pitch + dy * 0.005));
      }
      apply.current();
    };
    const up = () => {
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      v.dist = Math.min(400, Math.max(6, v.dist * Math.exp(e.deltaY * 0.001)));
      apply.current();
    };
    const menu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
    };
  }, [gl]);

  return null;
}
