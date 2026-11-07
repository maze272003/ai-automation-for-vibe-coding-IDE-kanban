import { describe, expect, test } from 'vitest';
import { MeshBasicMaterial } from 'three';
import { bubbleVisible, suiteAt } from '../../src/office3d/scene/Bubbles.tsx';
import { figuresSignature } from '../../src/office3d/scene/Agents.tsx';
import { bubbleText, facingFor, figureFrame, padRows, sheetVariant, WALK_STRIDE_M } from '../../src/office3d/scene/pose.ts';
import { figureGeometry, setFrameUv, type Sheet } from '../../src/office3d/scene/SpriteMaterial.ts';
import type { FigureState } from '../../src/office3d/state/figures.ts';

const fig = (over: Partial<FigureState> = {}): FigureState => ({
  id: 'run:1', roomId: 1, role: 'implementer', variant: 1, spotId: 'seat-implementer-0', path: [], pos: { x: 1, z: 1 },
  activity: 'coding', bubble: 'Coding a.ts', pending: null, arrivedAt: 0, leaving: false, leaveAt: null,
  seatId: 'seat-implementer-0', storyId: 1, ackedFails: [], ...over,
});

describe('figureFrame', () => {
  test('walking cycles the four walk frames by distance walked', () => {
    const walking = fig({ path: [{ x: 5, z: 5 }] });
    const frames = [0, 1, 2, 3, 4].map((k) => figureFrame(walking, 'seat', k * WALK_STRIDE_M + 0.01, 0).frame);
    expect(frames).toEqual(['walk-0', 'walk-1', 'walk-2', 'walk-3', 'walk-0']);
  });
  test('pose follows the spot the figure is at', () => {
    expect(figureFrame(fig({ activity: 'reading' }), 'sofa', 0, 0).frame).toBe('sit-read');
    expect(figureFrame(fig({ activity: 'reading', role: 'qa' }), 'lab-couch', 0, 0).frame).toBe('sit-read');
    expect(figureFrame(fig({ activity: 'thinking' }), 'coffee', 0, 0).frame).toBe('sip');
    expect(figureFrame(fig({ activity: 'qa-testing' }), 'test-board', 0, 0).frame).toBe('touch');
    expect(figureFrame(fig({ activity: 'qa-passed' }), 'test-board', 0, 0).frame).toBe('thumbs-up');
    expect(figureFrame(fig({ activity: 'qa-failure' }), 'whiteboard', 0, 0).frame).toBe('write-0');
    expect(figureFrame(fig({ activity: 'qa-failure' }), 'whiteboard', 0, 500).frame).toBe('write-1');
  });
  test('desk work types (animated); reading at a full lounge reads at the desk', () => {
    const a = figureFrame(fig(), 'seat', 0, 0);
    const b = figureFrame(fig(), 'seat', 0, 500);
    expect([a.frame, b.frame]).toEqual(['sit-type-0', 'sit-type-1']);
    expect(a.animated).toBe(true);
    expect(figureFrame(fig({ activity: 'reading' }), 'seat', 0, 0)).toEqual({ frame: 'sit-read', animated: false });
  });
  test('a figure standing at the door (leaving, arrived) idles', () => {
    expect(figureFrame(fig({ leaving: 'done' }), 'door', 0, 0).frame).toBe('idle');
  });
});

describe('sprite anchoring and facing', () => {
  test('seated frames drop by their 2 transparent bottom rows; standing frames do not', () => {
    expect(padRows('sit-type-0')).toBe(2);
    expect(padRows('sit-read')).toBe(2);
    expect(padRows('idle')).toBe(0);
    expect(padRows('walk-2')).toBe(0);
  });
  test('facing is relative to the camera', () => {
    const right = { x: 1, z: 0 };
    const forward = { x: 0, z: -1 }; // camera looks toward -z
    expect(facingFor({ x: 0, z: 1 }, right, forward)).toBe('front');
    expect(facingFor({ x: 0, z: -1 }, right, forward)).toBe('back');
    expect(facingFor({ x: 1, z: 0.2 }, right, forward)).toBe('right');
    expect(facingFor({ x: -1, z: 0.2 }, right, forward)).toBe('left');
    // Rotating the camera 90 degrees turns the same walk into a side view.
    expect(facingFor({ x: 0, z: 1 }, { x: 0, z: 1 }, { x: 1, z: 0 })).toBe('right');
  });
  test('only developers get per-run sheet variants', () => {
    expect(sheetVariant('implementer', 7)).toBe(3);
    expect(sheetVariant('planner', 3)).toBe(0);
    expect(sheetVariant('qa', 2)).toBe(0);
  });
  test('setFrameUv points the quad at the frame and mirrors for left', () => {
    const rect = { u0: 0.2, u1: 0.4, v0: 0.5, v1: 0.75 };
    const sheet: Sheet = { material: new MeshBasicMaterial(), front: { idle: rect }, back: { idle: { u0: 0, u1: 0.2, v0: 0, v1: 0.25 } } };
    const g = figureGeometry();
    setFrameUv(g, sheet, 'idle', 'front');
    const uv = () => Array.from(g.getAttribute('uv').array as Float32Array).map((n) => Math.round(n * 100) / 100);
    expect(uv()).toEqual([0.2, 0.75, 0.4, 0.75, 0.2, 0.5, 0.4, 0.5]);
    setFrameUv(g, sheet, 'idle', 'left');
    expect(uv()).toEqual([0.4, 0.75, 0.2, 0.75, 0.4, 0.5, 0.2, 0.5]);
    setFrameUv(g, sheet, 'idle', 'back');
    expect(uv()).toEqual([0, 0.25, 0.2, 0.25, 0, 0, 0.2, 0]);
    // The quad stands on its origin.
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBe(0);
    expect(g.boundingBox!.max.y).toBe(1);
  });
});

describe('bubbles', () => {
  test('bubble text is upper-cased for the pixel font; blank means none', () => {
    expect(bubbleText('Reading api.ts')).toBe('READING API.TS');
    expect(bubbleText('  ')).toBe('');
    expect(bubbleText('Done ✓')).toBe('DONE ✓');
  });
  test('bubbles show only for the hovered or selected suite', () => {
    expect(bubbleVisible(1, null, null)).toBe(false);
    expect(bubbleVisible(1, 1, null)).toBe(true);
    expect(bubbleVisible(1, null, 1)).toBe(true);
    expect(bubbleVisible(1, 2, 3)).toBe(false);
  });
  test('suiteAt finds the suite under a floor point (dev room or lab), ignoring dimmed suites', () => {
    const suite = (roomId: number, x0: number, dim: 'archived' | null = null) => ({
      roomId, dim,
      suite: { dev: { x0, z0: 0, x1: x0 + 14, z1: 12 }, lab: { x0: x0 + 14, z0: 0, x1: x0 + 22, z1: 12 } } as never,
    });
    const suites = [suite(1, 0), suite(2, 30), suite(3, 60, 'archived')];
    expect(suiteAt(suites, 5, 5)).toBe(1);
    expect(suiteAt(suites, 20, 5)).toBe(1);
    expect(suiteAt(suites, 40, 5)).toBe(2);
    expect(suiteAt(suites, 70, 5)).toBeNull();
    expect(suiteAt(suites, 25, 5)).toBeNull();
  });
});

describe('render-on-demand signature', () => {
  const kind = () => 'seat' as const;
  test('no figures: constant empty signature (an idle office draws no frames)', () => {
    expect(figuresSignature(new Map(), kind, 0)).toBe('');
    expect(figuresSignature(new Map(), kind, 500)).toBe('');
  });
  test('typing figures flip the pose phase at 2 Hz; non-animated poses do not', () => {
    const typing = new Map([['run:1', fig()]]);
    expect(figuresSignature(typing, kind, 0)).not.toBe(figuresSignature(typing, kind, 500));
    expect(figuresSignature(typing, kind, 0)).toBe(figuresSignature(typing, kind, 100));
    const reading = new Map([['run:1', fig({ activity: 'reading', spotId: 'sofa-0' })]]);
    expect(figuresSignature(reading, () => 'sofa', 0)).toBe(figuresSignature(reading, () => 'sofa', 500));
  });
  test('a bubble change requests a frame', () => {
    const a = new Map([['run:1', fig()]]);
    const b = new Map([['run:1', fig({ bubble: 'Coding b.ts' })]]);
    expect(figuresSignature(a, kind, 0)).not.toBe(figuresSignature(b, kind, 0));
  });
});
