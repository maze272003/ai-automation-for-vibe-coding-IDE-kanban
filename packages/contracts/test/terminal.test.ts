// packages/contracts/test/terminal.test.ts
import { describe, expect, it } from 'vitest';
import {
  TerminalClosePayload,
  TerminalOpenPayload,
  TerminalResizePayload,
  TerminalWritePayload,
} from '../src/index.ts';

describe('TerminalOpenPayload', () => {
  it('accepts a body with and without cwd', () => {
    expect(TerminalOpenPayload.safeParse({ cwd: 'C:\\repos\\demo', cols: 80, rows: 24 }).success).toBe(true);
    expect(TerminalOpenPayload.safeParse({ cols: 80, rows: 24 }).success).toBe(true);
  });

  it('rejects missing or non-integer cols/rows', () => {
    expect(TerminalOpenPayload.safeParse({ cwd: 'C:\\demo', rows: 24 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cwd: 'C:\\demo', cols: 80 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 80.5, rows: 24 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 80, rows: 24.5 }).success).toBe(false);
  });

  it('rejects cols/rows one step outside the bounds but accepts the edges', () => {
    expect(TerminalOpenPayload.safeParse({ cols: 1, rows: 24 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 501, rows: 24 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 80, rows: 1 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 80, rows: 301 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cols: 2, rows: 2 }).success).toBe(true);
    expect(TerminalOpenPayload.safeParse({ cols: 500, rows: 300 }).success).toBe(true);
  });

  it('caps cwd length and rejects an empty cwd', () => {
    expect(TerminalOpenPayload.safeParse({ cwd: 'a'.repeat(4096), cols: 80, rows: 24 }).success).toBe(true);
    expect(TerminalOpenPayload.safeParse({ cwd: 'a'.repeat(4097), cols: 80, rows: 24 }).success).toBe(false);
    expect(TerminalOpenPayload.safeParse({ cwd: '', cols: 80, rows: 24 }).success).toBe(false);
  });
});

describe('TerminalWritePayload', () => {
  it('accepts a typed body and id 0', () => {
    expect(TerminalWritePayload.safeParse({ id: 3, data: 'dir\r' }).success).toBe(true);
    expect(TerminalWritePayload.safeParse({ id: 0, data: 'x' }).success).toBe(true);
  });

  it('rejects a missing, non-integer, mistyped or negative id', () => {
    expect(TerminalWritePayload.safeParse({ data: 'x' }).success).toBe(false);
    expect(TerminalWritePayload.safeParse({ id: 1.5, data: 'x' }).success).toBe(false);
    expect(TerminalWritePayload.safeParse({ id: '3', data: 'x' }).success).toBe(false);
    expect(TerminalWritePayload.safeParse({ id: -1, data: 'x' }).success).toBe(false);
  });

  it('caps data length, rejecting empty and oversized writes', () => {
    expect(TerminalWritePayload.safeParse({ id: 1, data: 'x'.repeat(65_536) }).success).toBe(true);
    expect(TerminalWritePayload.safeParse({ id: 1, data: 'x'.repeat(65_537) }).success).toBe(false);
    expect(TerminalWritePayload.safeParse({ id: 1, data: '' }).success).toBe(false);
    expect(TerminalWritePayload.safeParse({ id: 1 }).success).toBe(false);
  });
});

describe('TerminalResizePayload', () => {
  it('accepts a resize body including the grid edges', () => {
    expect(TerminalResizePayload.safeParse({ id: 1, cols: 80, rows: 24 }).success).toBe(true);
    expect(TerminalResizePayload.safeParse({ id: 0, cols: 2, rows: 2 }).success).toBe(true);
    expect(TerminalResizePayload.safeParse({ id: 0, cols: 500, rows: 300 }).success).toBe(true);
  });

  it('rejects cols/rows outside the bounds and bad ids', () => {
    expect(TerminalResizePayload.safeParse({ id: 1, cols: 1, rows: 24 }).success).toBe(false);
    expect(TerminalResizePayload.safeParse({ id: 1, cols: 501, rows: 24 }).success).toBe(false);
    expect(TerminalResizePayload.safeParse({ id: 1, cols: 80, rows: 1 }).success).toBe(false);
    expect(TerminalResizePayload.safeParse({ id: 1, cols: 80, rows: 301 }).success).toBe(false);
    expect(TerminalResizePayload.safeParse({ id: 1.5, cols: 80, rows: 24 }).success).toBe(false);
    expect(TerminalResizePayload.safeParse({ id: -1, cols: 80, rows: 24 }).success).toBe(false);
  });
});

describe('TerminalClosePayload', () => {
  it('accepts a close body including id 0', () => {
    expect(TerminalClosePayload.safeParse({ id: 1 }).success).toBe(true);
    expect(TerminalClosePayload.safeParse({ id: 0 }).success).toBe(true);
  });

  it('rejects a missing, non-integer or negative id', () => {
    expect(TerminalClosePayload.safeParse({}).success).toBe(false);
    expect(TerminalClosePayload.safeParse({ id: 1.5 }).success).toBe(false);
    expect(TerminalClosePayload.safeParse({ id: -1 }).success).toBe(false);
  });
});
