// packages/contracts/src/diagnostics.ts
import { z } from 'zod';

/**
 * Bounds, request schemas and response DTOs for the advanced Diagnostics
 * surface (Phase 5.4 spec §API contract, IDE-7). Single source of truth shared
 * by the orchestrator routes, the desktop IPC handler and the UI.
 */

/** Bounds for a log-tail read, in bytes: 4 KiB–256 KiB, default 64 KiB. */
export const DIAGNOSTICS_LOG_TAIL = { min: 4_096, max: 262_144, default: 65_536 } as const;
/** Bounds for the recent-errors list length: 1–200, default 50. */
export const DIAGNOSTICS_ERROR_LIMIT = { min: 1, max: 200, default: 50 } as const;
/** Backups kept by the on-demand backup endpoint (same policy as startup backups). */
export const DIAGNOSTICS_MAX_BACKUPS = 5;
/** Minimum interval between on-demand backups, so a renderer cannot loop full-DB copies. */
export const DIAGNOSTICS_BACKUP_THROTTLE_MS = 10_000;
/** Copy shown on the Diagnostics page: restore is startup-failure-only. */
export const DIAGNOSTICS_RESTORE_NOTE =
  'Restore is offered from the startup failure screen when the database cannot open. Restoring a live database is intentionally blocked.';

/**
 * A log name must be one plain file name — no directory separators, no
 * alternate-data-stream colon — ending in `.log` or a rotation suffix
 * (`.log.1` … `.log.N`). The service re-checks containment on disk.
 */
export const DiagnosticsLogName = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.log(?:\.\d+)?$/);

export const DiagnosticsLogParams = z.object({ file: DiagnosticsLogName });

/**
 * `tailBytes` is coerced because query-string values arrive as text. Callers
 * must omit the parameter rather than send an empty value: `z.coerce.number()`
 * maps `''` to `0`, which fails the minimum instead of applying the default.
 */
export const DiagnosticsLogQuery = z.object({
  tailBytes: z.coerce
    .number()
    .int()
    .min(DIAGNOSTICS_LOG_TAIL.min)
    .max(DIAGNOSTICS_LOG_TAIL.max)
    .default(DIAGNOSTICS_LOG_TAIL.default),
});

export const DiagnosticsErrorsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(DIAGNOSTICS_ERROR_LIMIT.min)
    .max(DIAGNOSTICS_ERROR_LIMIT.max)
    .default(DIAGNOSTICS_ERROR_LIMIT.default),
});

export interface DiagnosticsComponentHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  detail: string;
}
export interface DiagnosticsLogFileDTO {
  name: string;
  size: number;
  modifiedAt: string;
}
export interface DiagnosticsLogListDTO {
  files: DiagnosticsLogFileDTO[];
}
export interface DiagnosticsLogContentDTO extends DiagnosticsLogFileDTO {
  content: string;
  truncated: boolean;
  redacted: true;
}
export type DiagnosticsErrorLevel = 'warn' | 'error' | 'fatal';
export interface DiagnosticsErrorDTO {
  file: string;
  time: string | null;
  level: DiagnosticsErrorLevel;
  message: string;
  detail: string | null;
}
export interface DiagnosticsErrorsDTO {
  errors: DiagnosticsErrorDTO[];
  scannedFiles: number;
}
export interface DiagnosticsHealthDTO {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  versions: { app: string; node: string; electron: string | null };
  memory: { rssBytes: number; heapUsedBytes: number };
  components: {
    db: DiagnosticsComponentHealth & { sizeBytes: number };
    logs: DiagnosticsComponentHealth & { fileCount: number };
    backups: DiagnosticsComponentHealth & { count: number; latest: DiagnosticsBackupDTO | null };
    opencode: DiagnosticsComponentHealth;
    gateway: DiagnosticsComponentHealth;
    github: DiagnosticsComponentHealth;
    ollama: DiagnosticsComponentHealth;
  };
}
export interface DiagnosticsBackupDTO {
  name: string;
  size: number;
  modifiedAt: string;
}
export interface DiagnosticsBackupsDTO {
  backups: DiagnosticsBackupDTO[];
  restoreNote: string;
}
export type DiagnosticsBackupResult = { ok: true; name: string; size: number } | { ok: false; reason: string };
export type DiagnosticsExportResult = { ok: true; path: string } | { ok: false; reason: string };
