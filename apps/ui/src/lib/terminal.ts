// apps/ui/src/lib/terminal.ts — pure helpers for the integrated terminal (IDE-5).
// No React, no @xterm/xterm import: plain values the panel feeds into xterm's options.
import { TERMINAL_CHUNK_BYTES, TERMINAL_COLS, TERMINAL_ROWS } from '@aik/contracts';
import type { TerminalOpenResult } from '@aik/contracts';

/**
 * The theme fields the panel sets on `new Terminal({ theme })`, as a plain object
 * (xterm's `ITheme` accepts exactly these keys; keeping our own shape avoids an
 * @xterm/xterm type import in this pure module).
 */
export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

/**
 * Terminal colors mirroring the Aurora tokens in `apps/ui/src/index.css`
 * (dark = the `.dark` block, light = the `:root` block). The literals are
 * deliberate: a drift between CSS and terminal is caught by the unit tests.
 */
export function xtermTheme(dark: boolean): TerminalThemeColors {
  return dark
    ? {
        background: '#090d1a', // --background
        foreground: '#eef1fb', // --foreground
        cursor: '#8b5cf6', // --accent
        cursorAccent: '#ffffff', // --accent-foreground
        selectionBackground: 'rgba(139, 92, 246, 0.35)', // translucent --accent
      }
    : {
        background: '#f4f4f8', // --background
        foreground: '#15161a', // --foreground
        cursor: '#6d28d9', // --accent
        cursorAccent: '#ffffff', // --accent-foreground
        selectionBackground: 'rgba(109, 40, 217, 0.30)', // translucent --accent
      };
}

/** Clamps a fitted grid into the contracts bounds; a NaN dimension falls back to the minimum. */
export function clampGrid(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (n: number, bounds: { min: number; max: number }) =>
    Number.isNaN(n) ? bounds.min : Math.min(bounds.max, Math.max(bounds.min, n));
  return { cols: clamp(cols, TERMINAL_COLS), rows: clamp(rows, TERMINAL_ROWS) };
}

/**
 * Splits input (a large paste) into chunks of at most TERMINAL_CHUNK_BYTES UTF-16
 * code units, each a whole number of code points: when a cut would land between
 * the halves of a surrogate pair it is moved back one unit. Empty input yields
 * no chunks.
 */
export function chunkInput(data: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + TERMINAL_CHUNK_BYTES, data.length);
    if (end < data.length && end - 1 > i) {
      const last = data.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never split a surrogate pair
    }
    chunks.push(data.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * Status-line copy for the panel: null while a session is live, the exit code
 * once the shell ended, friendly text per reason when the open was refused.
 */
export function terminalNotice(error: TerminalOpenResult | null, exitCode: number | null): string | null {
  if (error !== null && !error.ok) {
    switch (error.reason) {
      case 'BAD_REQUEST':
        return 'The terminal request was invalid.';
      case 'TOO_MANY_SESSIONS':
        return 'Too many terminal sessions are open. Close one and try again.';
      case 'INVALID_CWD':
        return 'That folder does not exist.';
      case 'SPAWN_FAILED':
        return `The shell could not start${error.message ? `: ${error.message}` : '.'}`;
    }
  }
  if (exitCode !== null) return `Session ended (exit code ${exitCode})`;
  return null;
}
