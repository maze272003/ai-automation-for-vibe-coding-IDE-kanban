import { describe, expect, test } from 'vitest';
import { VOXEL_MODELS } from '../../src/office3d/voxel/models';
import { meshVoxels } from '../../src/office3d/voxel/mesh';

describe('meshVoxels', () => {
  test('single cube has 6 faces; two adjacent cubes hide the shared faces', () => {
    expect(meshVoxels({ size: [1, 1, 1], cells: [[0, 0, 0, '#fff']] }).indices.length / 6).toBe(6);
    expect(
      meshVoxels({ size: [2, 1, 1], cells: [[0, 0, 0, '#fff'], [1, 0, 0, '#fff']] }).indices.length / 6,
    ).toBe(6);
  });
  test('different colours are not merged', () => {
    expect(
      meshVoxels({ size: [2, 1, 1], cells: [[0, 0, 0, '#fff'], [1, 0, 0, '#000']] }).indices.length / 6,
    ).toBe(10);
  });
  test('buffers are consistent and shading is baked', () => {
    const m = meshVoxels({ size: [1, 1, 1], cells: [[0, 0, 0, '#ffffff']] });
    expect(m.positions.length).toBe(24 * 3);
    expect(m.normals.length).toBe(m.positions.length);
    expect(m.colors.length).toBe(m.positions.length);
    const shades = new Set<number>();
    for (let i = 0; i < m.colors.length; i += 3) shades.add(Math.round(m.colors[i]! * 100));
    expect([...shades].sort((a, b) => a - b)).toEqual([50, 65, 80, 100]);
  });
  test('winding matches normals', () => {
    const m = meshVoxels({ size: [2, 2, 2], cells: [[0, 0, 0, '#fff'], [1, 1, 1, '#fff']] });
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const e1 = pb.map((v, i) => v - pa[i]!);
      const e2 = pc.map((v, i) => v - pa[i]!);
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = [m.normals[a * 3]!, m.normals[a * 3 + 1]!, m.normals[a * 3 + 2]!];
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });
});

describe('VOXEL_MODELS', () => {
  test('every model has cells inside its size', () => {
    for (const m of Object.values(VOXEL_MODELS)) {
      expect(m.cells.length).toBeGreaterThan(0);
      for (const [x, y, z] of m.cells) expect(x < m.size[0] && y < m.size[1] && z < m.size[2] && x >= 0 && y >= 0 && z >= 0).toBe(true);
    }
  });
  test('has all 16 props and no duplicate cells', () => {
    expect(Object.keys(VOXEL_MODELS)).toHaveLength(16);
    for (const m of Object.values(VOXEL_MODELS)) {
      const keys = new Set(m.cells.map(([x, y, z]) => `${x},${y},${z}`));
      expect(keys.size).toBe(m.cells.length);
      expect(meshVoxels(m).indices.length).toBeGreaterThan(0);
    }
  });
});
