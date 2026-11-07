import type { StationRole } from '@aik/contracts';
import { DoubleSide, MeshBasicMaterial, PlaneGeometry, type BufferAttribute } from 'three';
import { rolePalette } from '../sprites/palette.ts';
import { renderSheet, SPRITE_FRAMES, SPRITE_HEIGHT, SPRITE_WIDTH, type FrameRect } from '../sprites/sheets.ts';
import { pixelCanvasTexture } from './materials.ts';
import { sheetVariant, type Facing, type FrameName } from './pose.ts';

/** World size of one sprite pixel: a 17 px character is 1.7 m tall, 1.2 m wide. */
export const SPRITE_PX = 0.1;
export const SPRITE_W = SPRITE_WIDTH * SPRITE_PX;
export const SPRITE_H = SPRITE_HEIGHT * SPRITE_PX;

/** Back view: the face rows become hair (there is no separate back art; the body rows are shared). */
const BACK_HEAD = ['...HHHHHH...', '..HHHHHHHH..', '..HHHHHHHH..', '..HHHHHHHH..', '..HHHHHHHH..', '...sHHHHs...', '....SSSS....'];
const HEAD_ROWS = BACK_HEAD.length;
const BACK_FRAMES = Object.fromEntries(
  Object.entries(SPRITE_FRAMES).map(([k, rows]) => [k, [...BACK_HEAD, ...rows.slice(HEAD_ROWS)]]),
) as typeof SPRITE_FRAMES;

type UvRect = { u0: number; u1: number; v0: number; v1: number };
export type Sheet = { material: MeshBasicMaterial; front: Record<string, UvRect>; back: Record<string, UvRect> };

const sheets = new Map<string, Sheet>();

const toUv = (r: FrameRect, oy: number, w: number, h: number): UvRect => ({
  u0: r.x / w,
  u1: (r.x + r.w) / w,
  // CanvasTexture flips Y: canvas row 0 is v = 1.
  v1: 1 - (r.y + oy) / h,
  v0: 1 - (r.y + oy + r.h) / h,
});

/**
 * One texture + material per (role, variant) sheet, shared by every figure that uses it. The canvas holds the
 * front frames on top and the back frames below. Nearest filtering (crisp pixels) and alpha-test (no sorting)
 * come from `pixelCanvasTexture` + `alphaTest`. In-memory canvas only (CSP).
 */
export function sheetFor(role: StationRole, variant: number): Sheet {
  const v = sheetVariant(role, variant);
  const key = `${role}:${v}`;
  const hit = sheets.get(key);
  if (hit) return hit;
  const palette = rolePalette(role, v);
  const noop = { fillStyle: '', fillRect() {} };
  const { width, height } = renderSheet(SPRITE_FRAMES, palette, 1, noop);
  const { ctx, texture } = pixelCanvasTexture(width, height * 2);
  const front = renderSheet(SPRITE_FRAMES, palette, 1, ctx);
  const shifted = {
    get fillStyle() {
      return ctx.fillStyle;
    },
    set fillStyle(c: string) {
      ctx.fillStyle = c;
    },
    fillRect: (x: number, y: number, w: number, h: number) => ctx.fillRect(x, y + height, w, h),
  };
  const back = renderSheet(BACK_FRAMES, palette, 1, shifted);
  const uv = (rects: Record<string, FrameRect>, oy: number) =>
    Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, toUv(r, oy, width, height * 2)]));
  const material = new MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: DoubleSide, toneMapped: false });
  const sheet: Sheet = { material, front: uv(front.frameRects, 0), back: uv(back.frameRects, height) };
  sheets.set(key, sheet);
  return sheet;
}

/** A 1 x 1 quad with its base at y = 0 (the sprite stands on its origin); UVs are rewritten per frame. */
export function figureGeometry(): PlaneGeometry {
  return new PlaneGeometry(1, 1).translate(0, 0.5, 0);
}

/** Points a figure quad's UVs at a frame; left facing mirrors the frame horizontally. */
export function setFrameUv(geometry: PlaneGeometry, sheet: Sheet, frame: FrameName, facing: Facing): void {
  const r = (facing === 'back' ? sheet.back : sheet.front)[frame]!;
  const [a, b] = facing === 'left' ? [r.u1, r.u0] : [r.u0, r.u1];
  // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right.
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  uv.setXY(0, a, r.v1);
  uv.setXY(1, b, r.v1);
  uv.setXY(2, a, r.v0);
  uv.setXY(3, b, r.v0);
  uv.needsUpdate = true;
}
