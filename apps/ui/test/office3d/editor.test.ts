import { describe, expect, test } from 'vitest';
import type { FurnitureItem } from '@aik/contracts';
import { editorReduce, initialEditorState, type EditorState } from '../../src/office3d/editor/editor-state.ts';
import { defaultRoomLayout } from '../../src/office3d/layout/room.ts';

const extra = (id: string, kind: FurnitureItem['kind'], x: number, z: number): FurnitureItem => ({ id, kind, area: 'dev', x, z, rotationY: 0 });
const base = (): EditorState =>
  initialEditorState(1, [...defaultRoomLayout(), extra('plant-1', 'plant', 8.5, 1), extra('desk-x', 'desk', 12, 7.5)]);
const item = (s: EditorState, id: string) => s.items.find((i) => i.id === id)!;

describe('editorReduce', () => {
  test('move snaps to 0.25 m', () => {
    const n = editorReduce(base(), { type: 'move', id: 'plant-1', x: 1.13, z: 2.02 });
    expect(item(n, 'plant-1')).toMatchObject({ x: 1.25, z: 2 });
    expect(n.dirty).toBe(true);
    expect(n.lastError).toBeNull();
  });
  test('invalid move is refused and reported', () => {
    const s = base();
    const n = editorReduce(s, { type: 'move', id: 'plant-1', x: 7, z: 8 });
    expect(n.items).toEqual(s.items);
    expect(n.lastError).toMatch(/walkway/);
  });
  test('special items cannot be deleted', () => {
    expect(editorReduce(base(), { type: 'delete', id: 'coffee' }).lastError).toMatch(/moved but not removed/);
  });
  test('plain items can be deleted', () => {
    const n = editorReduce(base(), { type: 'delete', id: 'plant-1' });
    expect(n.items.some((i) => i.id === 'plant-1')).toBe(false);
    expect(n.dirty).toBe(true);
  });
  test('rotate steps wrap at 360', () => {
    expect(item(editorReduce(base(), { type: 'rotate', id: 'desk-x', step: 15 }), 'desk-x').rotationY).toBe(15);
    let s = base();
    for (let k = 0; k < 4; k++) s = editorReduce(s, { type: 'rotate', id: 'desk-x', step: 90 });
    expect(item(s, 'desk-x').rotationY).toBe(0);
  });
  test('add places a snapped item with a fresh id', () => {
    const n = editorReduce(base(), { type: 'add', kind: 'plant', area: 'dev', x: 9.1, z: 6.4 });
    const added = n.items.filter((i) => i.kind === 'plant' && i.id !== 'plant-1' && i.id !== 'lab-plant');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ area: 'dev', x: 9, z: 6.5, rotationY: 0 });
    expect(n.selectedId).toBe(added[0]!.id);
  });
  test('invalid add is refused', () => {
    const s = base();
    const n = editorReduce(s, { type: 'add', kind: 'desk', area: 'dev', x: 7, z: 2 });
    expect(n.items).toEqual(s.items);
    expect(n.lastError).toMatch(/walkway/);
  });
  test('reset returns the default layout', () => {
    const dirty = editorReduce(base(), { type: 'move', id: 'plant-1', x: 1, z: 2 });
    const n = editorReduce(dirty, { type: 'reset' });
    expect(n.items).toEqual(defaultRoomLayout());
    expect(n.selectedId).toBeNull();
  });
  test('select sets and clears the selection and the error', () => {
    const err = editorReduce(base(), { type: 'delete', id: 'coffee' });
    const n = editorReduce(err, { type: 'select', id: 'plant-1' });
    expect(n.selectedId).toBe('plant-1');
    expect(n.lastError).toBeNull();
    expect(editorReduce(n, { type: 'select', id: null }).selectedId).toBeNull();
  });
  test('unknown ids are ignored', () => {
    const s = base();
    expect(editorReduce(s, { type: 'move', id: 'nope', x: 1, z: 1 }).items).toEqual(s.items);
  });
});
