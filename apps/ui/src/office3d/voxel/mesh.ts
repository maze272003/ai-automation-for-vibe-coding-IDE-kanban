import { GRID } from '../layout/dimensions';
import type { VoxelModel } from './models';

export type VoxelMesh = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
};

/** Per-axis shading baked into vertex colours (y is up). */
const SHADE_TOP = 1;
const SHADE_X = 0.8;
const SHADE_Z = 0.65;
const SHADE_BOTTOM = 0.5;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function shade(axis: number, sign: number): number {
  if (axis === 1) return sign > 0 ? SHADE_TOP : SHADE_BOTTOM;
  return axis === 0 ? SHADE_X : SHADE_Z;
}

/**
 * Greedy voxel mesher. Emits only faces whose neighbour cell is empty and merges
 * coplanar, same-colour faces into rectangles. Positions are in metres
 * (cell index * GRID), model origin at the min corner; y is up. Triangles are
 * counter-clockwise when seen from outside.
 */
export function meshVoxels(m: VoxelModel): VoxelMesh {
  const [sx, sy, sz] = m.size;
  const dims = [sx, sy, sz];
  const grid = new Map<number, string>();
  const key = (x: number, y: number, z: number) => (x * sy + y) * sz + z;
  for (const [x, y, z, c] of m.cells) grid.set(key(x, y, z), c.toLowerCase());
  const at = (x: number, y: number, z: number): string | undefined =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? undefined : grid.get(key(x, y, z));

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    for (const sign of [1, -1]) {
      for (let slice = 0; slice < dims[d]!; slice++) {
        const mask: Array<string | undefined> = new Array(du * dv);
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++) {
            const p = [0, 0, 0];
            p[d] = slice;
            p[u] = i;
            p[v] = j;
            const q = [...p];
            q[d] = slice + sign;
            const here = at(p[0]!, p[1]!, p[2]!);
            mask[i + j * du] = here !== undefined && at(q[0]!, q[1]!, q[2]!) === undefined ? here : undefined;
          }
        }
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; ) {
            const c = mask[i + j * du];
            if (c === undefined) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < du && mask[i + w + j * du] === c) w++;
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * du] !== c) break outer;
              h++;
            }
            for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) mask[i + a + (j + b) * du] = undefined;

            const origin = [0, 0, 0];
            origin[d] = sign > 0 ? slice + 1 : slice;
            origin[u] = i;
            origin[v] = j;
            const vu = [0, 0, 0];
            vu[u] = w;
            const vv = [0, 0, 0];
            vv[v] = h;
            const base = positions.length / 3;
            const [r, g, bl] = hexToRgb(c);
            const s = shade(d, sign);
            const corners = [
              origin,
              origin.map((o, k) => o + vu[k]!),
              origin.map((o, k) => o + vu[k]! + vv[k]!),
              origin.map((o, k) => o + vv[k]!),
            ];
            for (const cn of corners) {
              positions.push(cn[0]! * GRID, cn[1]! * GRID, cn[2]! * GRID);
              const n = [0, 0, 0];
              n[d] = sign;
              normals.push(n[0]!, n[1]!, n[2]!);
              colors.push(r * s, g * s, bl * s);
            }
            // u x v = +d (cyclic axes), so 0,1,2 is CCW seen from +d.
            if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
            i += w;
          }
        }
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
