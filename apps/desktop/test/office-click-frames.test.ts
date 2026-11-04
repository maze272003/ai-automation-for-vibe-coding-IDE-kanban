// apps/desktop/test/office-click-frames.test.ts — behavioral tests for the pure
// pixel-agents WebSocket frame parser (spec 2026-11-04-office-agent-activity, CDP
// variant). Frame shapes come from their webview source: focusAgent {id} is sent on
// click; agentCreated {id, directoryName}, existingAgents {directoryNames} and
// agentClosed {id} are received broadcasts.
import { describe, expect, test } from 'vitest';
import { applyOfficeFrame, officeClickLabel, type OfficeFrameMap } from '../src/main/office-click-frames.ts';

const frame = (msg: unknown): string => JSON.stringify(msg);

describe('officeClickLabel', () => {
  test('a focusAgent frame with a known id resolves to the character label', () => {
    const labels: OfficeFrameMap = new Map([[3, 'INV-7 planner']]);
    expect(officeClickLabel(labels, frame({ type: 'focusAgent', id: 3 }))).toBe('INV-7 planner');
  });

  test('an unknown id yields null (click before the label map is populated)', () => {
    expect(officeClickLabel(new Map(), frame({ type: 'focusAgent', id: 42 }))).toBeNull();
  });

  test('non-JSON payloads yield null without throwing', () => {
    const labels: OfficeFrameMap = new Map([[1, 'INV-1 planner']]);
    expect(officeClickLabel(labels, 'not json {')).toBeNull();
  });

  test('non-focusAgent frames yield null even when the id is known', () => {
    const labels: OfficeFrameMap = new Map([[1, 'INV-1 planner']]);
    expect(officeClickLabel(labels, frame({ type: 'agentCreated', id: 1, directoryName: 'INV-1 planner' }))).toBeNull();
  });
});

describe('applyOfficeFrame', () => {
  test('agentCreated populates the map; non-number ids and empty names are ignored', () => {
    const labels: OfficeFrameMap = new Map();
    applyOfficeFrame(labels, frame({ type: 'agentCreated', id: 5, directoryName: 'INV-9 implementer' }));
    expect(labels.get(5)).toBe('INV-9 implementer');
    applyOfficeFrame(labels, frame({ type: 'agentCreated', id: '6', directoryName: 'INV-10 planner' }));
    applyOfficeFrame(labels, frame({ type: 'agentCreated', id: 7, directoryName: '' }));
    expect(labels.size).toBe(1);
  });

  test('existingAgents directoryNames populates the map, rejecting NaN keys and bad values', () => {
    const labels: OfficeFrameMap = new Map();
    applyOfficeFrame(labels, frame({ type: 'existingAgents', directoryNames: { 1: 'INV-1 planner', 2: 'INV-2 reviewer', oops: 'INV-3 planner', 4: null } }));
    expect(labels.get(1)).toBe('INV-1 planner');
    expect(labels.get(2)).toBe('INV-2 reviewer');
    expect(labels.size).toBe(2); // 'oops' → NaN key; 4 → non-string name
  });

  test('agentClosed removes the id', () => {
    const labels: OfficeFrameMap = new Map([[7, 'INV-7 planner'], [8, 'INV-8 reviewer']]);
    applyOfficeFrame(labels, frame({ type: 'agentClosed', id: 7 }));
    expect(labels.has(7)).toBe(false);
    expect(labels.get(8)).toBe('INV-8 reviewer');
  });

  test('unrelated frame types, non-object JSON and non-JSON payloads are ignored without throwing', () => {
    const labels: OfficeFrameMap = new Map([[1, 'INV-1 planner']]);
    applyOfficeFrame(labels, frame({ type: 'terminalOutput', data: 'x' }));
    applyOfficeFrame(labels, frame('a plain string'));
    applyOfficeFrame(labels, '{broken');
    applyOfficeFrame(labels, 'null');
    applyOfficeFrame(labels, '42');
    expect(labels.size).toBe(1);
    expect(labels.get(1)).toBe('INV-1 planner');
  });
});
