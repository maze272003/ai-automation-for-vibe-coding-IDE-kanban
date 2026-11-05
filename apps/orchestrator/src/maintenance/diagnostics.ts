// apps/orchestrator/src/maintenance/diagnostics.ts
import {
  DIAGNOSTICS_BACKUP_THROTTLE_MS,
  DIAGNOSTICS_LOG_NAME_RE,
  DIAGNOSTICS_LOG_TAIL,
  DIAGNOSTICS_MAX_BACKUPS,
  type DiagnosticsBackupDTO,
  type DiagnosticsBackupResult,
  type DiagnosticsComponentHealth,
  type DiagnosticsErrorDTO,
  type DiagnosticsErrorLevel,
  type DiagnosticsErrorsDTO,
  type DiagnosticsHealthComponents,
  type DiagnosticsHealthDTO,
  type DiagnosticsLogContentDTO,
  type DiagnosticsLogFileDTO,
} from '@aik/contracts';
import { backupFileName, projects, providers, pruneBackups, type AikDb } from '@aik/db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRedactor, type Redactor } from '../secrets/redactor.ts';
import { describeHits, scanText } from '../secrets/scan.ts';

/** Extra component probes supplied by the composition root (app.ts). */
export interface DiagnosticsExtraComponents {
  opencode?: DiagnosticsComponentHealth;
  gateway?: DiagnosticsComponentHealth;
  github?: DiagnosticsComponentHealth;
  ollama?: DiagnosticsComponentHealth;
}

export interface DiagnosticsDeps {
  db: AikDb;
  logsDir?: string;
  backupsDir?: string;
  version?: string;
  electronVersion?: string | null;
  redactor?: Redactor;
  /** Injectable clock: backup names and the throttle window (tests only). */
  now?: () => Date;
  extraComponents?: () => DiagnosticsExtraComponents;
}

export interface DiagnosticsArchive {
  version: string;
  timestamp: string;
  diagnostics: {
    platform: {
      os: string;
      arch: string;
      nodeVersion: string;
      uptimeSeconds: number;
    };
    database: {
      sizeBytes: number;
      pageCount: number;
      pageSize: number;
    };
    projects: Array<{
      id: number;
      name: string;
      repoPath: string;
      settings: unknown;
    }>;
    providers: Array<{
      id: number;
      name: string;
      kind: string;
      baseUrl: string;
      hasApiKey: boolean;
    }>;
    logs: Array<{
      file: string;
      content: string;
    }>;
  };
}

/** One safe, regular log file inside `logsDir`. */
interface LogEntry {
  name: string;
  fullPath: string;
  size: number;
  modifiedAt: Date;
}

const MAX_EXPORT_FILES = 20;
const MAX_EXPORT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_MESSAGE = 500;
const MAX_ERROR_DETAIL = 2_000;
const BACKUP_NAME_RE = /^app-.*\.db$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Windows paths are case-insensitive; compare resolved canonical paths. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Maps a pino numeric/string level to the diagnostics error levels. */
function errorLevel(value: unknown): DiagnosticsErrorLevel | null {
  if (typeof value === 'number') {
    if (value >= 60) return 'fatal';
    if (value >= 50) return 'error';
    if (value >= 40) return 'warn';
    return null;
  }
  if (typeof value === 'string') {
    const level = value.toLowerCase();
    if (level === 'fatal' || level === 'error' || level === 'warn') return level;
    if (level === 'warning') return 'warn';
  }
  return null;
}

function normalizeTime(value: unknown): string | null {
  const date =
    typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Extracts a redactable error detail without ever returning a raw log line. */
function errorDetail(obj: Record<string, unknown>): string | null {
  const err = obj.err ?? obj.error;
  if (isRecord(err)) {
    if (typeof err.stack === 'string') return err.stack;
    if (typeof err.message === 'string') return err.message;
  }
  if (typeof err === 'string') return err;
  if (typeof obj.stack === 'string') return obj.stack;
  return null;
}

export class DiagnosticsService {
  private readonly db: AikDb;
  private readonly logsDir?: string;
  private readonly backupsDir?: string;
  private readonly version: string;
  private readonly electronVersion: string | null;
  private readonly redactor: Redactor;
  private readonly now: () => Date;
  private readonly extraComponents?: () => DiagnosticsExtraComponents;

  private backupInFlight: Promise<DiagnosticsBackupResult> | null = null;
  private lastBackupAt = Number.NEGATIVE_INFINITY;

  constructor(deps: DiagnosticsDeps) {
    this.db = deps.db;
    this.logsDir = deps.logsDir;
    this.backupsDir = deps.backupsDir;
    this.version = deps.version ?? '0.0.0';
    this.electronVersion = deps.electronVersion ?? null;
    this.redactor = deps.redactor ?? createRedactor();
    this.now = deps.now ?? (() => new Date());
    this.extraComponents = deps.extraComponents;
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  /**
   * Every readable, regular log file, newest first. A name must match the
   * allow-list regex, be a regular file (`lstat`, so links are rejected), and
   * resolve to a real path directly inside the resolved logs directory.
   */
  private listLogEntries(): LogEntry[] {
    if (!this.logsDir) return [];
    let names: string[];
    let realRoot: string;
    try {
      names = fs.readdirSync(this.logsDir);
      realRoot = fs.realpathSync(this.logsDir);
    } catch {
      return [];
    }

    const entries: LogEntry[] = [];
    for (const name of names) {
      if (!DIAGNOSTICS_LOG_NAME_RE.test(name)) continue;
      const fullPath = path.join(this.logsDir, name);
      try {
        if (!fs.lstatSync(fullPath).isFile()) continue;
        const real = fs.realpathSync(fullPath);
        if (!samePath(real, path.join(realRoot, name))) continue;
        const stat = fs.statSync(real);
        if (!stat.isFile()) continue;
        entries.push({ name, fullPath: real, size: stat.size, modifiedAt: stat.mtime });
      } catch {
        // vanished or unreadable: skip
      }
    }
    entries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return entries;
  }

  /** Public listing used by `GET /diagnostics/logs`. */
  listLogs(): DiagnosticsLogFileDTO[] {
    return this.listLogEntries().map((entry) => ({
      name: entry.name,
      size: entry.size,
      modifiedAt: entry.modifiedAt.toISOString(),
    }));
  }

  private findLog(name: string): LogEntry | null {
    if (!DIAGNOSTICS_LOG_NAME_RE.test(name)) return null;
    return this.listLogEntries().find((entry) => entry.name === name) ?? null;
  }

  /**
   * Reads the last `tailBytes` of a file (never the whole file). When the read
   * starts mid-line, everything before the first newline is dropped so the
   * viewer never renders a partial record.
   */
  private readTail(entry: LogEntry, tailBytes: number): { content: string; truncated: boolean } | null {
    let fd: number | null = null;
    try {
      fd = fs.openSync(entry.fullPath, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return null;
      const size = stat.size;
      const length = Math.min(tailBytes, size);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      let content = buffer.subarray(0, read).toString('utf8');
      const truncated = start > 0;
      if (truncated) {
        const newline = content.indexOf('\n');
        content = newline >= 0 ? content.slice(newline + 1) : '';
      }
      return { content, truncated };
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }

  /**
   * Tail read + redaction + fail-closed secret scan. Returns null for an
   * unknown/invalid name; throws rather than returning content that still
   * matches a known secret family.
   */
  readLog(name: string, tailBytes: number = DIAGNOSTICS_LOG_TAIL.default): DiagnosticsLogContentDTO | null {
    const entry = this.findLog(name);
    if (!entry) return null;
    const tail = this.readTail(entry, tailBytes);
    if (!tail) return null;

    const content = this.redactor.redact(tail.content);
    const hits = scanText(content, entry.name);
    if (hits.length > 0) {
      throw new Error(`Log content blocked by secret scanning: ${describeHits(hits)}`);
    }

    return {
      name: entry.name,
      size: entry.size,
      modifiedAt: entry.modifiedAt.toISOString(),
      content,
      truncated: tail.truncated,
      redacted: true,
    };
  }

  /** Recent pino warn/error/fatal entries, newest first, redacted and scanned. */
  recentErrors(limit: number): DiagnosticsErrorsDTO {
    const errors: DiagnosticsErrorDTO[] = [];
    let scannedFiles = 0;

    for (const entry of this.listLogEntries()) {
      const tail = this.readTail(entry, DIAGNOSTICS_LOG_TAIL.max);
      if (!tail) continue;
      scannedFiles += 1;

      for (const line of tail.content.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // raw stdio / non-JSON audit lines
        }
        if (!isRecord(parsed)) continue;
        const level = errorLevel(parsed.level);
        if (!level) continue;

        const message = typeof parsed.msg === 'string'
          ? parsed.msg
          : typeof parsed.message === 'string'
            ? parsed.message
            : '';
        const detail = errorDetail(parsed);
        const redactedMessage = this.redactor.redact(message).slice(0, MAX_ERROR_MESSAGE);
        const redactedDetail = detail === null
          ? null
          : this.redactor.redact(detail).slice(0, MAX_ERROR_DETAIL);

        const hits = scanText(`${redactedMessage}\n${redactedDetail ?? ''}`, entry.name);
        if (hits.length > 0) continue; // fail closed: omit rather than leak

        errors.push({
          file: entry.name,
          time: normalizeTime(parsed.time),
          level,
          message: redactedMessage,
          detail: redactedDetail,
        });
      }
    }

    errors.sort((a, b) => {
      const at = a.time === null ? Number.NEGATIVE_INFINITY : Date.parse(a.time);
      const bt = b.time === null ? Number.NEGATIVE_INFINITY : Date.parse(b.time);
      return bt - at;
    });

    return { errors: errors.slice(0, limit), scannedFiles };
  }

  // ── Health ───────────────────────────────────────────────────────────────

  private databaseStats(): { ok: boolean; sizeBytes: number; pageCount: number; pageSize: number } {
    try {
      this.db.$client.prepare('SELECT 1').get();
    } catch {
      return { ok: false, sizeBytes: 0, pageCount: 0, pageSize: 0 };
    }
    try {
      const pageCount = Number(this.db.$client.pragma('page_count', { simple: true }) ?? 0);
      const pageSize = Number(this.db.$client.pragma('page_size', { simple: true }) ?? 0);
      return { ok: true, sizeBytes: pageCount * pageSize, pageCount, pageSize };
    } catch {
      return { ok: true, sizeBytes: 0, pageCount: 0, pageSize: 0 };
    }
  }

  private logsState(): { status: DiagnosticsComponentHealth['status']; detail: string; files: DiagnosticsLogFileDTO[] } {
    if (!this.logsDir) return { status: 'unavailable', detail: 'not configured', files: [] };
    try {
      if (!fs.statSync(this.logsDir).isDirectory()) {
        return { status: 'degraded', detail: 'logs path is not a directory', files: [] };
      }
    } catch {
      return { status: 'degraded', detail: 'logs directory missing', files: [] };
    }
    const files = this.listLogs();
    return { status: 'ok', detail: `${files.length} log file${files.length === 1 ? '' : 's'}`, files };
  }

  private backupsState(): {
    status: DiagnosticsComponentHealth['status'];
    detail: string;
    items: DiagnosticsBackupDTO[];
  } {
    if (!this.backupsDir) return { status: 'unavailable', detail: 'not configured', items: [] };
    try {
      if (!fs.existsSync(this.backupsDir)) return { status: 'ok', detail: 'no backups yet', items: [] };
      const items = this.listBackups();
      return {
        status: 'ok',
        detail: items.length === 0 ? 'no backups yet' : `${items.length} backup${items.length === 1 ? '' : 's'}`,
        items,
      };
    } catch {
      return { status: 'degraded', detail: 'backups unreadable', items: [] };
    }
  }

  /** Snapshot used by the Diagnostics page (parent §17.3 component list). */
  health(): DiagnosticsHealthDTO {
    const database = this.databaseStats();
    const logs = this.logsState();
    const backups = this.backupsState();
    const extra = this.extraComponents?.() ?? {};
    const fallback = (name: string): DiagnosticsComponentHealth => ({
      status: 'unavailable',
      detail: `${name} not configured`,
    });

    const components: DiagnosticsHealthComponents = {
      db: {
        status: database.ok ? 'ok' : 'degraded',
        detail: database.ok ? 'database reachable' : 'database check failed',
        sizeBytes: database.sizeBytes,
      },
      logs: { status: logs.status, detail: logs.detail, fileCount: logs.files.length },
      backups: {
        status: backups.status,
        detail: backups.detail,
        count: backups.items.length,
        latest: backups.items[0] ?? null,
      },
      opencode: extra.opencode ?? fallback('OpenCode'),
      gateway: extra.gateway ?? fallback('Gateway'),
      github: extra.github ?? fallback('GitHub'),
      ollama: extra.ollama ?? fallback('Ollama'),
    };

    const status = Object.values(components).every((component) => component.status === 'ok')
      ? 'ok'
      : 'degraded';
    const memory = process.memoryUsage();

    return {
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      versions: {
        app: this.version,
        node: process.version,
        electron: this.electronVersion,
      },
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      components,
    };
  }

  // ── Backups ──────────────────────────────────────────────────────────────

  listBackups(): DiagnosticsBackupDTO[] {
    if (!this.backupsDir) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const backups: Array<DiagnosticsBackupDTO & { mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_NAME_RE.test(entry.name)) continue;
      const fullPath = path.join(this.backupsDir, entry.name);
      try {
        const stat = fs.lstatSync(fullPath);
        if (!stat.isFile()) continue;
        backups.push({
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // vanished: skip
      }
    }
    backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return backups.map(({ mtimeMs: _mtimeMs, ...backup }) => backup);
  }

  private async runBackup(now: Date): Promise<DiagnosticsBackupResult> {
    if (!this.backupsDir) return { ok: false, reason: 'backups unavailable' };
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const name = backupFileName(now);
      const target = path.join(this.backupsDir, name);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      this.db.$client.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      pruneBackups(this.backupsDir, DIAGNOSTICS_MAX_BACKUPS);
      const stat = fs.statSync(target);
      return { ok: true, name, size: stat.size };
    } catch {
      return { ok: false, reason: 'backup failed' };
    }
  }

  /**
   * On-demand `VACUUM INTO` backup. Single-flight (concurrent callers share the
   * result) and throttled so a compromised renderer cannot loop full DB copies.
   */
  async createBackup(now: Date = this.now()): Promise<DiagnosticsBackupResult> {
    if (this.backupInFlight) return this.backupInFlight;
    if (now.getTime() - this.lastBackupAt < DIAGNOSTICS_BACKUP_THROTTLE_MS) {
      return { ok: false, reason: 'throttled' };
    }
    this.lastBackupAt = now.getTime();
    const run = this.runBackup(now);
    this.backupInFlight = run.finally(() => {
      this.backupInFlight = null;
    });
    return this.backupInFlight;
  }

  // ── Archive ──────────────────────────────────────────────────────────────

  async exportArchive(): Promise<DiagnosticsArchive> {
    const platform = {
      os: `${os.type()} ${os.release()} (${os.platform()})`,
      arch: os.arch(),
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    const database = this.databaseStats();

    const rawProjects = this.db
      .select({
        id: projects.id,
        name: projects.name,
        repoPath: projects.repoPath,
        settings: projects.settings,
      })
      .from(projects)
      .all();

    const rawProviders = this.db
      .select({
        id: providers.id,
        name: providers.name,
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        keyRef: providers.keyRef,
      })
      .from(providers)
      .all();

    const sanitizedProviders = rawProviders.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.keyRef),
    }));

    // Bounded, safe tails: newest 20 files and at most 2 MiB across the archive.
    const collectedLogs: Array<{ file: string; content: string }> = [];
    let totalBytes = 0;
    for (const entry of this.listLogEntries().slice(0, MAX_EXPORT_FILES)) {
      if (totalBytes >= MAX_EXPORT_LOG_BYTES) break;
      const tail = this.readTail(entry, DIAGNOSTICS_LOG_TAIL.max);
      if (!tail) continue;
      let content = tail.content;
      const remaining = MAX_EXPORT_LOG_BYTES - totalBytes;
      const encoded = Buffer.from(content);
      if (encoded.byteLength > remaining) {
        content = encoded.subarray(encoded.byteLength - remaining).toString('utf8');
      }
      totalBytes += Buffer.byteLength(content);
      collectedLogs.push({ file: entry.name, content: this.redactor.redact(content) });
    }

    const archive: DiagnosticsArchive = {
      version: this.version,
      timestamp: new Date().toISOString(),
      diagnostics: {
        platform,
        database: {
          sizeBytes: database.sizeBytes,
          pageCount: database.pageCount,
          pageSize: database.pageSize,
        },
        projects: rawProjects,
        providers: sanitizedProviders,
        logs: collectedLogs,
      },
    };

    const serialized = JSON.stringify(archive);
    const fullyRedacted = this.redactor.redact(serialized);
    const hits = scanText(fullyRedacted, 'diagnostics.json');
    if (hits.length > 0) {
      throw new Error(`Diagnostics export failed secret scanning: ${describeHits(hits)}`);
    }

    return JSON.parse(fullyRedacted) as DiagnosticsArchive;
  }
}
