import { useThree } from '@react-three/fiber';
import { useEffect, useRef, type MutableRefObject } from 'react';
import { Plane, Raycaster, Sprite, SpriteMaterial, Vector2, Vector3, type CanvasTexture, type Group } from 'three';
import type { Rect } from '../layout/geometry.ts';
import { paintBubble } from '../screens/paint.ts';
import type { Ctx2D } from '../screens/pixel-font.ts';
import type { SuiteModel } from './derive.ts';
import { pixelCanvasTexture } from './materials.ts';

/** One bubble to draw this frame: world anchor above the figure's head and the (already shortened) text. */
export type BubbleItem = { id: string; roomId: number; x: number; y: number; z: number; text: string };
export type BubbleUpdate = (items: BubbleItem[]) => void;

/** Bubble canvas: 40 glyphs x 6 px + padding fits in 256 px; one glyph row + frame + tail = 16 px. */
const CANVAS_W = 256;
const CANVAS_H = 16;
/** World metres per bubble pixel at the reference distance; bubbles scale with distance (≈ constant on screen). */
const BUBBLE_PX = 0.03;
const REF_DISTANCE = 20;
const MIN_SCALE = 0.8;
/** The tail is painted at x 3..5 (screens/paint.ts): the sprite is anchored there, at its bottom edge. */
const TAIL_X = 4.5;

/** Bubbles show only for the hovered or the selected suite (spec 6.5a: avoids clutter in overview). */
export function bubbleVisible(roomId: number, hovered: number | null, selected: number | null): boolean {
  return roomId === hovered || roomId === selected;
}

/** The suite whose floor (dev room or QA lab) contains a world point. */
export function suiteAt(suites: Array<Pick<SuiteModel, 'roomId' | 'suite' | 'dim'>>, x: number, z: number): number | null {
  const inside = (r: Rect) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
  return suites.find((s) => s.dim === null && (inside(s.suite.dev) || inside(s.suite.lab)))?.roomId ?? null;
}

type Entry = { sprite: Sprite; material: SpriteMaterial; texture: CanvasTexture; ctx: Ctx2D; text: string; w: number; h: number };

const ground = new Plane(new Vector3(0, 1, 0), 0);
const ray = new Raycaster();
const ndc = new Vector2();
const hit = new Vector3();

/**
 * Speech bubbles above the figures: camera-facing sprites with a pixel frame and pixel font, one small
 * in-memory canvas each, repainted only when the text changes. Agents calls `update` at the end of each of
 * its frames (so bubbles always match the figures); hovering a suite floor shows its bubbles.
 */
export function Bubbles({ suites, selectedRoomId, update }: { suites: SuiteModel[]; selectedRoomId: number | null; update: MutableRefObject<BubbleUpdate | null> }) {
  const group = useRef<Group>(null);
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const entries = useRef(new Map<string, Entry>());
  const hovered = useRef<number | null>(null);
  const suitesRef = useRef(suites);
  suitesRef.current = suites;
  const selectedRef = useRef(selectedRoomId);
  selectedRef.current = selectedRoomId;

  useEffect(() => {
    invalidate(); // selection changed: show/hide bubbles
  }, [selectedRoomId, invalidate]);

  // Hover: the suite under the pointer, from a ray against the floor plane (no per-object raycasts).
  useEffect(() => {
    const el = gl.domElement;
    const set = (id: number | null) => {
      if (hovered.current === id) return;
      hovered.current = id;
      invalidate();
    };
    const move = (e: PointerEvent) => {
      if (e.buttons !== 0) return; // dragging the camera
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, get().camera);
      set(ray.ray.intersectPlane(ground, hit) ? suiteAt(suitesRef.current, hit.x, hit.z) : null);
    };
    const leave = () => set(null);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [gl, get, invalidate]);

  update.current = (items) => {
    const g = group.current;
    if (!g) return;
    const map = entries.current;
    const keep = new Set<string>();
    const cam = get().camera.position;
    for (const it of items) {
      if (it.text === '' || !bubbleVisible(it.roomId, hovered.current, selectedRef.current)) continue;
      keep.add(it.id);
      let e = map.get(it.id);
      if (!e) {
        const { ctx, texture } = pixelCanvasTexture(CANVAS_W, CANVAS_H);
        const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
        const sprite = new Sprite(material);
        sprite.renderOrder = 10;
        sprite.raycast = () => {}; // bubbles never take clicks from the figures or stations below
        g.add(sprite);
        e = { sprite, material, texture, ctx, text: '', w: 1, h: 1 };
        map.set(it.id, e);
      }
      if (e.text !== it.text) {
        e.ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        const { w, h } = paintBubble(e.ctx, it.text);
        e.w = Math.min(w, CANVAS_W);
        e.h = Math.min(h, CANVAS_H);
        e.texture.repeat.set(e.w / CANVAS_W, e.h / CANVAS_H);
        e.texture.offset.set(0, 1 - e.h / CANVAS_H); // canvas top-left region (CanvasTexture flips Y)
        e.texture.needsUpdate = true;
        e.sprite.center.set(TAIL_X / e.w, 0);
        e.text = it.text;
      }
      e.sprite.position.set(it.x, it.y, it.z);
      const k = Math.max(MIN_SCALE, cam.distanceTo(e.sprite.position) / REF_DISTANCE);
      e.sprite.scale.set(e.w * BUBBLE_PX * k, e.h * BUBBLE_PX * k, 1);
    }
    for (const [id, e] of map) {
      if (keep.has(id)) continue;
      g.remove(e.sprite);
      e.material.dispose();
      e.texture.dispose();
      map.delete(id);
    }
  };

  useEffect(
    () => () => {
      update.current = null;
      for (const e of entries.current.values()) {
        e.material.dispose();
        e.texture.dispose();
      }
      entries.current.clear();
    },
    [update],
  );

  return <group ref={group} />;
}
