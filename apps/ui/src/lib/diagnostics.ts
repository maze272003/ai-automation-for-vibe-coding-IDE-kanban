// apps/ui/src/lib/diagnostics.ts — pure formatting helpers for the Diagnostics
// page (Phase 5.4 spec K-13/K-14, IDE-7). Node-testable: no DOM, no clock reads
// unless a caller omits `now` explicitly.
import type {
  DiagnosticsBackupDTO,
  DiagnosticsErrorDTO,
  DiagnosticsErrorLevel,
  DiagnosticsLogFileDTO,
} from '@aik/contracts';

/** Component-level health as reported by `GET /diagnostics/health`. */
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';
/** The subset of Badge tones health/error badges use. */
export type HealthTone = 'ok' | 'warn' | 'danger';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Human-readable byte size with binary units (`1.5 KiB`). Deterministic. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KIB) return `${Math.floor(bytes)} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

/**
 * Relative age of an ISO timestamp. Invalid or missing timestamps and future
 * clocks are clamped rather than rendered as negative ages.
 */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const reference = Number.isFinite(now) ? now : Date.now();
  const seconds = Math.max(0, Math.floor((reference - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Compact uptime such as `2d 4h`, `3h 12m`, `45m 8s` or `12s`. */
export function formatUptime(totalSeconds: number): string {
  const seconds = !Number.isFinite(totalSeconds) || totalSeconds <= 0 ? 0 : Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Maps a component health status onto a diagnostic badge tone. */
export function healthTone(status: HealthStatus): HealthTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'unavailable':
      return 'danger';
  }
}

/** Maps a parsed log level onto a diagnostic badge tone. */
export function errorLevelTone(level: DiagnosticsErrorLevel): HealthTone {
  return level === 'warn' ? 'warn' : 'danger';
}

/** `name · size · age`, used for backup rows and health summaries. */
export function backupLabel(dto: DiagnosticsBackupDTO, now: number = Date.now()): string {
  return `${dto.name} · ${formatBytes(dto.size)} · ${formatAge(dto.modifiedAt, now)}`;
}

/** `name · size · age`, used for the log-file `<select>` options. */
export function logOptionLabel(dto: DiagnosticsLogFileDTO, now: number = Date.now()): string {
  return `${dto.name} · ${formatBytes(dto.size)} · ${formatAge(dto.modifiedAt, now)}`;
}

/**
 * Newest parseable `time` among the errors, independent of array order.
 * Returns the original string so callers render exactly what the API sent.
 */
export function latestErrorTime(errors: readonly DiagnosticsErrorDTO[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const error of errors) {
    if (!error.time) continue;
    const ms = Date.parse(error.time);
    if (!Number.isFinite(ms)) continue;
    if (ms > latestMs) {
      latest = error.time;
      latestMs = ms;
    }
  }
  return latest;
}
