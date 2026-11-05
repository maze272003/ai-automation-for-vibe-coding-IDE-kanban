// apps/ui/test/terminal.test.ts
import { describe, expect, test } from 'vitest';
import { TERMINAL_CHUNK_BYTES, TERMINAL_COLS, TERMINAL_ROWS } from '@aik/contracts';
import { chunkInput, clampGrid, terminalNotice, xtermTheme } from '../src/lib/terminal.ts';

/** Every chunk must be well-formed UTF-16: a high surrogate is always followed by its low half. */
function expectWellFormed(chunks: string[]): void {
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const code = chunk.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < chunk.length ? chunk.charCodeAt(i + 1) : 0;
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i += 1; // the low half was just verified
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  }
}

describe('terminal lib', () => {
  describe('xtermTheme', () => {
    test('dark theme uses the exact .dark Aurora tokens from index.css', () => {
      expect(xtermTheme(true)).toEqual({
        background: '#090d1a', // --background
        foreground: '#eef1fb', // --foreground
        cursor: '#8b5cf6', // --accent
        cursorAccent: '#ffffff', // --accent-foreground
        selectionBackground: 'rgba(139, 92, 246, 0.35)',
      });
    });

    test('light theme uses the exact :root tokens from index.css', () => {
      expect(xtermTheme(false)).toEqual({
        background: '#f4f4f8', // --background
        foreground: '#15161a', // --foreground
        cursor: '#6d28d9', // --accent
        cursorAccent: '#ffffff', // --accent-foreground
        selectionBackground: 'rgba(109, 40, 217, 0.30)',
      });
    });

    test('dark and light themes differ', () => {
      expect(xtermTheme(true)).not.toEqual(xtermTheme(false));
    });
  });

  describe('clampGrid', () => {
    test('clamps below-range dimensions to the bounds minimum', () => {
      expect(clampGrid(1, 1)).toEqual({ cols: TERMINAL_COLS.min, rows: TERMINAL_ROWS.min });
    });

    test('clamps above-range dimensions to the bounds maximum', () => {
      expect(clampGrid(501, 301)).toEqual({ cols: TERMINAL_COLS.max, rows: TERMINAL_ROWS.max });
    });

    test('leaves in-range grids untouched, including the bound edges', () => {
      expect(clampGrid(80, 24)).toEqual({ cols: 80, rows: 24 });
      expect(clampGrid(TERMINAL_COLS.min, TERMINAL_ROWS.min)).toEqual({ cols: 2, rows: 2 });
      expect(clampGrid(TERMINAL_COLS.max, TERMINAL_ROWS.max)).toEqual({ cols: 500, rows: 300 });
    });

    test('NaN falls back to the minimum', () => {
      expect(clampGrid(Number.NaN, Number.NaN)).toEqual({ cols: TERMINAL_COLS.min, rows: TERMINAL_ROWS.min });
      expect(clampGrid(Number.NaN, 24)).toEqual({ cols: TERMINAL_COLS.min, rows: 24 });
      expect(clampGrid(80, Number.NaN)).toEqual({ cols: 80, rows: TERMINAL_ROWS.min });
    });
  });

  describe('chunkInput', () => {
    test('empty input yields no chunks', () => {
      expect(chunkInput('')).toEqual([]);
    });

    test('input within the limit is a single chunk', () => {
      expect(chunkInput('abc')).toEqual(['abc']);
      const exact = 'x'.repeat(TERMINAL_CHUNK_BYTES);
      expect(chunkInput(exact)).toEqual([exact]);
    });

    test('input of 2*limit+1 units splits into three chunks at the limit', () => {
      const data = 'x'.repeat(TERMINAL_CHUNK_BYTES * 2 + 1);
      const chunks = chunkInput(data);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(TERMINAL_CHUNK_BYTES);
      expect(chunks[1]).toHaveLength(TERMINAL_CHUNK_BYTES);
      expect(chunks[2]).toBe('x');
      expect(chunks.join('')).toBe(data);
    });

    test('never splits a surrogate pair (aligned)', () => {
      const pairs = '𝕏'.repeat(TERMINAL_CHUNK_BYTES + 10); // 𝕏 = U+1D54F, one surrogate pair
      const chunks = chunkInput(pairs);
      expect(chunks.join('')).toBe(pairs);
      expectWellFormed(chunks);
    });

    test('never splits a surrogate pair (boundary lands mid-pair)', () => {
      // The leading BMP char shifts every later pair to an odd index, so the first
      // cut would land between the halves of a pair and must move back one unit.
      const input = 'x' + '𝕏'.repeat(TERMINAL_CHUNK_BYTES);
      const chunks = chunkInput(input);
      expect(chunks.join('')).toBe(input);
      expect(chunks[0]).toHaveLength(TERMINAL_CHUNK_BYTES - 1);
      expectWellFormed(chunks);
    });
  });

  describe('terminalNotice', () => {
    test('null while a session is live', () => {
      expect(terminalNotice(null, null)).toBeNull();
      expect(terminalNotice({ ok: true, id: 3, cwd: 'C:\\repo' }, null)).toBeNull();
    });

    test('reports the exit code when the shell ended', () => {
      expect(terminalNotice(null, 0)).toBe('Session ended (exit code 0)');
      expect(terminalNotice(null, 1)).toBe('Session ended (exit code 1)');
    });

    test('maps every open-failure reason to friendly copy', () => {
      expect(terminalNotice({ ok: false, reason: 'BAD_REQUEST' }, null)).toBe('The terminal request was invalid.');
      expect(terminalNotice({ ok: false, reason: 'TOO_MANY_SESSIONS' }, null)).toBe(
        'Too many terminal sessions are open. Close one and try again.',
      );
      expect(terminalNotice({ ok: false, reason: 'INVALID_CWD' }, null)).toBe('That folder does not exist.');
      expect(terminalNotice({ ok: false, reason: 'SPAWN_FAILED' }, null)).toBe('The shell could not start.');
      expect(terminalNotice({ ok: false, reason: 'SPAWN_FAILED', message: 'spawn cmd.exe ENOENT' }, null)).toBe(
        'The shell could not start: spawn cmd.exe ENOENT',
      );
    });
  });
});
