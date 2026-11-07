/**
 * Pure-data voxel prop models (original designs, "B" mockup style: chunky
 * low-poly furniture). One cell = GRID (0.25 m). Axes: x right, y up, z depth.
 * Models are built from box primitives; later boxes overwrite earlier cells.
 */
export type VoxelModel = {
  size: [number, number, number];
  cells: Array<[number, number, number, string]>;
};

type Box = [x: number, y: number, z: number, w: number, h: number, d: number, colour: string];

function build(size: [number, number, number], boxes: Box[]): VoxelModel {
  const map = new Map<string, [number, number, number, string]>();
  for (const [x, y, z, w, h, d, c] of boxes)
    for (let i = x; i < x + w; i++)
      for (let j = y; j < y + h; j++)
        for (let k = z; k < z + d; k++) {
          if (i < 0 || j < 0 || k < 0 || i >= size[0] || j >= size[1] || k >= size[2]) {
            throw new Error('voxel box out of bounds');
          }
          map.set(`${i},${j},${k}`, [i, j, k, c]);
        }
  return { size, cells: [...map.values()] };
}

const WOOD = '#a16207';
const WOOD_D = '#78350f';
const METAL = '#94a3b8';
const DARK = '#1e293b';
const SCREEN = '#38bdf8';

export const VOXEL_MODELS: Record<
  | 'desk'
  | 'chair'
  | 'monitor'
  | 'keyboard'
  | 'mug'
  | 'sofa'
  | 'plant'
  | 'lamp'
  | 'coffee-machine'
  | 'counter'
  | 'huddle-table'
  | 'stool'
  | 'whiteboard'
  | 'test-board-frame'
  | 'bookshelf'
  | 'rug',
  VoxelModel
> = {
  // 6 x 3 x 3 (1.5 x 0.75 x 0.75 m)
  desk: build([6, 3, 3], [
    [0, 2, 0, 6, 1, 3, WOOD],
    [0, 0, 0, 1, 2, 1, WOOD_D],
    [5, 0, 0, 1, 2, 1, WOOD_D],
    [0, 0, 2, 1, 2, 1, WOOD_D],
    [5, 0, 2, 1, 2, 1, WOOD_D],
  ]),
  // 2 x 4 x 2: base, seat, back rest on the z=0 side
  chair: build([2, 4, 2], [
    [0, 0, 0, 2, 1, 2, DARK],
    [0, 1, 0, 2, 1, 2, '#475569'],
    [0, 2, 0, 2, 2, 1, '#334155'],
  ]),
  // 3 x 3 x 1: screen on a stand
  monitor: build([3, 3, 1], [
    [1, 0, 0, 1, 1, 1, METAL],
    [0, 1, 0, 3, 2, 1, DARK],
    [1, 1, 0, 1, 2, 1, SCREEN],
  ]),
  keyboard: build([3, 1, 1], [
    [0, 0, 0, 3, 1, 1, '#cbd5e1'],
    [1, 0, 0, 1, 1, 1, '#64748b'],
  ]),
  mug: build([1, 1, 1], [[0, 0, 0, 1, 1, 1, '#f8fafc']]),
  // 8 x 3 x 3: seat, back, two arms
  sofa: build([8, 3, 3], [
    [0, 0, 0, 8, 1, 3, '#7c3aed'],
    [1, 1, 0, 6, 1, 3, '#8b5cf6'],
    [1, 1, 0, 6, 2, 1, '#6d28d9'],
    [0, 1, 0, 1, 2, 3, '#6d28d9'],
    [7, 1, 0, 1, 2, 3, '#6d28d9'],
  ]),
  // 3 x 6 x 3: pot, stem, leafy crown
  plant: build([3, 6, 3], [
    [0, 0, 0, 3, 1, 3, '#c2410c'],
    [1, 1, 1, 1, 2, 1, '#166534'],
    [0, 3, 0, 3, 2, 3, '#22c55e'],
    [1, 5, 1, 1, 1, 1, '#4ade80'],
  ]),
  // 2 x 7 x 2: base, pole, shade
  lamp: build([2, 7, 2], [
    [0, 0, 0, 2, 1, 2, DARK],
    [0, 1, 0, 1, 4, 1, METAL],
    [0, 5, 0, 2, 2, 2, '#fde047'],
  ]),
  // 3 x 5 x 3: body, dark top, nozzle and cup
  'coffee-machine': build([3, 5, 3], [
    [0, 0, 0, 3, 5, 3, '#475569'],
    [0, 4, 0, 3, 1, 3, DARK],
    [1, 2, 2, 1, 1, 1, '#f97316'],
    [1, 1, 2, 1, 1, 1, '#f8fafc'],
  ]),
  // 8 x 4 x 3: kitchen counter with top
  counter: build([8, 4, 3], [
    [0, 0, 0, 8, 3, 3, '#64748b'],
    [0, 3, 0, 8, 1, 3, '#e2e8f0'],
    [1, 0, 2, 2, 3, 1, '#475569'],
    [5, 0, 2, 2, 3, 1, '#475569'],
  ]),
  // 6 x 3 x 6: octagonal-ish top on a pedestal
  'huddle-table': build([6, 3, 6], [
    [1, 2, 0, 4, 1, 6, WOOD],
    [0, 2, 1, 6, 1, 4, WOOD],
    [2, 0, 2, 2, 2, 2, WOOD_D],
  ]),
  // 2 x 3 x 2
  stool: build([2, 3, 2], [
    [0, 2, 0, 2, 1, 2, '#f59e0b'],
    [0, 0, 0, 1, 2, 1, METAL],
    [1, 0, 1, 1, 2, 1, METAL],
  ]),
  // 8 x 5 x 1: board with marker colours, on feet
  whiteboard: build([8, 5, 1], [
    [0, 1, 0, 8, 4, 1, '#94a3b8'],
    [1, 2, 0, 6, 2, 1, '#f8fafc'],
    [2, 3, 0, 2, 1, 1, '#3b82f6'],
    [5, 2, 0, 2, 1, 1, '#ef4444'],
    [1, 0, 0, 1, 1, 1, METAL],
    [6, 0, 0, 1, 1, 1, METAL],
  ]),
  // 8 x 6 x 1: open frame that holds test cards
  'test-board-frame': build([8, 6, 1], [
    [0, 0, 0, 8, 1, 1, '#0e7490'],
    [0, 5, 0, 8, 1, 1, '#0e7490'],
    [0, 1, 0, 1, 4, 1, '#0e7490'],
    [7, 1, 0, 1, 4, 1, '#0e7490'],
    [3, 1, 0, 2, 4, 1, '#155e75'],
  ]),
  // 6 x 8 x 2: shelves with books
  bookshelf: build([6, 8, 2], [
    [0, 0, 0, 6, 8, 2, WOOD_D],
    [1, 1, 1, 4, 2, 1, '#ef4444'],
    [1, 4, 1, 4, 2, 1, '#3b82f6'],
    [1, 7, 1, 4, 1, 1, '#22c55e'],
    [0, 3, 0, 6, 1, 1, WOOD],
    [0, 6, 0, 6, 1, 1, WOOD],
    [1, 1, 1, 1, 2, 1, '#facc15'],
    [3, 4, 1, 1, 2, 1, '#f97316'],
  ]),
  // 12 x 1 x 8: flat floor rug with border
  rug: build([12, 1, 8], [
    [0, 0, 0, 12, 1, 8, '#9f1239'],
    [1, 0, 1, 10, 1, 6, '#be123c'],
    [2, 0, 2, 8, 1, 4, '#fda4af'],
  ]),
};
