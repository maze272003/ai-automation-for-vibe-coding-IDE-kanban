import { describe, expect, test } from 'vitest';
import { SPRITE_FRAMES, SPRITE_WIDTH, SPRITE_HEIGHT } from '../../src/office3d/sprites/sheets';
import { rolePalette } from '../../src/office3d/sprites/palette';
import { renderSheet } from '../../src/office3d/sprites/sheets';

describe('sprites', () => {
  test('all sprite frames are 12 wide, 17 tall and use known palette keys', () => {
    const keys = new Set(['.', ...Object.keys(rolePalette('implementer', 0))]);
    expect(Object.keys(SPRITE_FRAMES)).toHaveLength(13);
    for (const rows of Object.values(SPRITE_FRAMES)) {
      expect(rows).toHaveLength(SPRITE_HEIGHT);
      for (const r of rows) {
        expect(r).toHaveLength(SPRITE_WIDTH);
        for (const ch of r) expect(keys.has(ch)).toBe(true);
      }
    }
  });
  test('role palettes use the role shirt colour', () => {
    expect(rolePalette('qa', 0).T).toBe('#22d3ee');
    expect(rolePalette('planner', 1).T).toBe('#60a5fa');
    expect(rolePalette('implementer', 0).T).toBe('#f59e0b');
    expect(rolePalette('reviewer', 0).T).toBe('#a78bfa');
    expect(rolePalette('pm', 0).T).toBe('#4ade80');
  });
  test('variants change hair/skin', () => {
    const seen = new Set([0, 1, 2, 3].map((v) => `${rolePalette('pm', v).H}${rolePalette('pm', v).S}`));
    expect(seen.size).toBe(4);
    expect(rolePalette('pm', 4)).toEqual(rolePalette('pm', 0));
  });
  test('renderSheet paints frames without overlap', () => {
    const rects: Array<[number, number, number, number]> = [];
    const ctx = { fillStyle: '', fillRect: (x: number, y: number, w: number, h: number) => void rects.push([x, y, w, h]) };
    const { frameRects } = renderSheet(SPRITE_FRAMES, rolePalette('qa', 0), 4, ctx);
    const fr = Object.values(frameRects);
    expect(fr).toHaveLength(13);
    for (let i = 0; i < fr.length; i++)
      for (let j = i + 1; j < fr.length; j++) {
        const a = fr[i]!, b = fr[j]!;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    expect(rects.length).toBeGreaterThan(100);
    for (const [x, y, w, h] of rects) expect(fr.some((f) => x >= f.x && y >= f.y && x + w <= f.x + f.w && y + h <= f.y + f.h)).toBe(true);
  });
});
