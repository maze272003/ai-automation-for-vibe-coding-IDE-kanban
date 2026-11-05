// packages/contracts/src/terminal.ts
import { z } from 'zod';

/**
 * Payload bounds and schemas for the integrated-terminal IPC channels
 * `aik:terminal-open|write|resize|close` (Phase 5.3 spec §IPC contract, IDE-5).
 * Single source of truth shared by the desktop handlers and the UI's grid clamp
 * and paste chunking (spec decision T-11).
 */

/** Maximum concurrent terminal sessions. */
export const TERMINAL_MAX_SESSIONS = 8;
/** Maximum bytes accepted by a single write call. */
export const TERMINAL_MAX_WRITE_BYTES = 65_536;
/** Panel-side paste chunking size, in bytes. */
export const TERMINAL_CHUNK_BYTES = 16 * 1024;
/** Column bounds for a terminal grid. */
export const TERMINAL_COLS = { min: 2, max: 500 } as const;
/** Row bounds for a terminal grid. */
export const TERMINAL_ROWS = { min: 2, max: 300 } as const;
/** Maximum length of a working-directory string. */
export const TERMINAL_MAX_CWD = 4096;

export const TerminalOpenPayload = z.object({
  cwd: z.string().min(1).max(TERMINAL_MAX_CWD).optional(),
  cols: z.number().int().min(TERMINAL_COLS.min).max(TERMINAL_COLS.max),
  rows: z.number().int().min(TERMINAL_ROWS.min).max(TERMINAL_ROWS.max),
});
export type TerminalOpenPayload = z.infer<typeof TerminalOpenPayload>;

export const TerminalWritePayload = z.object({
  id: z.number().int().min(0),
  data: z.string().min(1).max(TERMINAL_MAX_WRITE_BYTES),
});
export type TerminalWritePayload = z.infer<typeof TerminalWritePayload>;

export const TerminalResizePayload = z.object({
  id: z.number().int().min(0),
  cols: z.number().int().min(TERMINAL_COLS.min).max(TERMINAL_COLS.max),
  rows: z.number().int().min(TERMINAL_ROWS.min).max(TERMINAL_ROWS.max),
});
export type TerminalResizePayload = z.infer<typeof TerminalResizePayload>;

export const TerminalClosePayload = z.object({
  id: z.number().int().min(0),
});
export type TerminalClosePayload = z.infer<typeof TerminalClosePayload>;
