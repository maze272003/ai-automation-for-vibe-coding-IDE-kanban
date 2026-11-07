// apps/orchestrator/test/diagnostics-service.test.ts
//
// Task 3: DiagnosticsService log safety, recent errors, health, backups and the
// bounded export. Every path is an OS temp directory (`helpers/temp.ts`).
import {
  DIAGNOSTICS_LOG_TAIL,
  DIAGNOSTICS_MAX_BACKUPS,
  type DiagnosticsHealthComponents,
} from '@aik/contracts';
import { backupFileName, type AikDb } from '@aik/db';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DiagnosticsService } from '../src/maintenance/diagnostics.ts';
import type { Redactor } from '../src/secrets/redactor.ts';
import { createTestDb, seedProject } from './helpers/db.ts';
import { makeTempDir } from './helpers/temp.ts';

const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const FAKE_GITHUB_TOKEN = ['ghp', 'a'.repeat(36)].join('_');

/** A redactor that intentionally does nothing, to prove the scan is fail-closed. */
const identityRedactor: Redactor = {
  addSecret: () => undefined,
  removeSecret: () => undefined,
  redact: (text) => text,
};

function writeLog(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Symlinks need Developer Mode/Administrator on Windows: probe once and skip if unavailable. */
const symlinkProbeDir = makeTempDir('aik-symlink-probe-');
let symlinkSupported = false;
try {
  const target = path.join(symlinkProbeDir, 'target.log');
  const link = path.join(symlinkProbeDir, 'link.log');
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, link, 'file');
  symlinkSupported = true;
} catch {
  symlinkSupported = false;
}

describe('DiagnosticsService (IDE-7)', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let logsDir: string;
  let backupsDir: string;

  beforeAll(() => {
    dbHolder = createTestDb();
    seedProject(dbHolder.db, { name: 'Diagnostics Project', repoPath: 'C:/repos/diagnostics' });
    logsDir = makeTempDir('diagnostics-logs-');
    backupsDir = makeTempDir('diagnostics-backups-');
  });

  afterAll(() => {
    dbHolder.close();
    fs.rmSync(symlinkProbeDir, { recursive: true, force: true });
  });

  // ── Log listing / tail reads ─────────────────────────────────────────────

  describe('listLogs', () => {
    test('accepts rotation names, newest first, and hides non-log files', () => {
      const dir = makeTempDir('diagnostics-list-');
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const names = ['orchestrator.log', 'orchestrator.log.3', 'orchestrator-stdio.log'];
      names.forEach((name, index) => {
        const file = writeLog(dir, name, `${name}\n`);
        const when = new Date(base + index * 1_000);
        fs.utimesSync(file, when, when);
      });
      writeLog(dir, 'notes.txt', 'not a log');
      writeLog(dir, '.hidden.log', 'hidden');
      fs.mkdirSync(path.join(dir, 'dir.log'));

      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      expect(service.listLogs().map((entry) => entry.name)).toEqual([
        'orchestrator-stdio.log',
        'orchestrator.log.3',
        'orchestrator.log',
      ]);
    });

    test('returns [] for a missing or unreadable directory', () => {
      const missing = path.join(makeTempDir('diagnostics-missing-'), 'nope');
      expect(new DiagnosticsService({ db: dbHolder.db, logsDir: missing }).listLogs()).toEqual([]);
      const fileAsDir = writeLog(makeTempDir('diagnostics-file-dir-'), 'x.log', 'x');
      expect(new DiagnosticsService({ db: dbHolder.db, logsDir: fileAsDir }).listLogs()).toEqual([]);
    });
  });

  describe('readLog', () => {
    test('reads only the tail, drops the partial first line and reports truncation', () => {
      const dir = makeTempDir('diagnostics-tail-');
      const full = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(3, '0')}-${'a'.repeat(60)}`).join('\n');
      const file = writeLog(dir, 'orchestrator.log', full);
      const when = new Date('2026-02-03T04:05:06.000Z');
      fs.utimesSync(file, when, when);

      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const result = service.readLog('orchestrator.log', DIAGNOSTICS_LOG_TAIL.min);

      expect(result).not.toBeNull();
      expect(result?.truncated).toBe(true);
      expect(result?.size).toBe(Buffer.byteLength(full));
      expect(result?.modifiedAt).toBe(when.toISOString());
      expect(result?.redacted).toBe(true);
      expect(Buffer.byteLength(result?.content ?? '')).toBeLessThanOrEqual(DIAGNOSTICS_LOG_TAIL.min);
      for (const line of (result?.content ?? '').split('\n').filter(Boolean)) {
        expect(line).toMatch(/^line-\d{3}-a{60}$/);
      }
    });

    test('returns the whole file with truncated=false when it fits', () => {
      const dir = makeTempDir('diagnostics-whole-');
      writeLog(dir, 'orchestrator.log', 'small\n');
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const result = service.readLog('orchestrator.log');
      expect(result?.content).toBe('small\n');
      expect(result?.truncated).toBe(false);
    });

    test('keeps UTF-8 text intact after a mid-character tail boundary', () => {
      const dir = makeTempDir('diagnostics-utf8-');
      const content = Array.from({ length: 300 }, () => `${'é'.repeat(30)}`).join('\n');
      writeLog(dir, 'orchestrator.log', content);
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const result = service.readLog('orchestrator.log', DIAGNOSTICS_LOG_TAIL.min);
      expect(result?.truncated).toBe(true);
      expect(result?.content).not.toContain('\uFFFD');
    });

    test('rejects unknown, escaping and non-log names', () => {
      const dir = makeTempDir('diagnostics-names-');
      writeLog(dir, 'orchestrator.log', 'ok\n');
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      for (const name of ['', 'notes.txt', '../orchestrator.log', 'a/b.log', 'a\\b.log', '.hidden.log', 'app.db', 'evil.log:stream', 'x'.repeat(160) + '.log']) {
        expect(service.readLog(name)).toBeNull();
      }
      expect(service.readLog('orchestrator.log')).not.toBeNull();
    });

    test.skipIf(!symlinkSupported)('rejects a symlink that escapes the logs directory', () => {
      const dir = makeTempDir('diagnostics-link-');
      const outside = writeLog(makeTempDir('diagnostics-outside-'), 'secret.log', 'SECRET\n');
      fs.symlinkSync(outside, path.join(dir, 'escape.log'), 'file');
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      expect(service.listLogs()).toEqual([]);
      expect(service.readLog('escape.log')).toBeNull();
    });

    test('redacts known secrets before returning content', () => {
      const dir = makeTempDir('diagnostics-redact-');
      writeLog(dir, 'orchestrator.log', `auth ${FAKE_GITHUB_TOKEN} and ${FAKE_AWS_KEY}\n`);
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const result = service.readLog('orchestrator.log');
      expect(result?.content).not.toContain(FAKE_GITHUB_TOKEN);
      expect(result?.content).not.toContain(FAKE_AWS_KEY);
      expect(result?.content).toContain('[REDACTED:github-token]');
      expect(result?.content).toContain('[REDACTED:aws-key]');
    });

    test('fails closed when redaction leaves a known secret behind', () => {
      const dir = makeTempDir('diagnostics-failclosed-');
      writeLog(dir, 'orchestrator.log', `${FAKE_AWS_KEY}\n`);
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir, redactor: identityRedactor });
      expect(() => service.readLog('orchestrator.log')).toThrow(/secret scanning/i);
    });
  });

  // ── Recent errors ────────────────────────────────────────────────────────

  describe('recentErrors', () => {
    test('parses warn/error/fatal JSON lines, orders newest first and caps the limit', () => {
      const dir = makeTempDir('diagnostics-errors-');
      const lines = [
        { level: 30, time: '2026-03-01T00:00:00.000Z', msg: 'debug-ish info' },
        { level: 40, time: '2026-03-01T00:01:00.000Z', msg: 'warn one' },
        { level: 50, time: 1_772_323_320_000, msg: 'error epoch' },
        { level: 60, time: '2026-03-01T00:03:00.000Z', msg: 'fatal one', err: { stack: 'stack line' } },
        { level: 'warn', time: '2026-03-01T00:04:00.000Z', message: 'string level' },
        { level: 'error', msg: 'no time' },
        { level: 30, time: '2026-03-01T00:05:00.000Z', msg: 'ignored info' },
      ];
      writeLog(
        dir,
        'orchestrator.log',
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json stdio line\n{bad json\n`,
      );
      writeLog(dir, 'orchestrator.log.1', `${JSON.stringify({ level: 50, time: '2026-02-01T00:00:00.000Z', msg: 'older' })}\n`);

      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const { errors, scannedFiles } = service.recentErrors(4);

      expect(scannedFiles).toBe(2);
      expect(errors).toHaveLength(4);
      expect(errors.map((e) => e.level)).toEqual(['warn', 'fatal', 'error', 'warn']);
      expect(errors[2]?.message).toBe('error epoch');
      expect(errors[1]?.detail).toBe('stack line');
      expect(errors[3]?.message).toBe('warn one');
      expect(errors.some((e) => e.message === 'debug-ish info' || e.message === 'ignored info')).toBe(false);

      const all = service.recentErrors(50);
      expect(all.errors).toHaveLength(6);
      expect(all.errors.at(-1)?.time).toBeNull();
      expect(all.errors.at(-2)?.message).toBe('older');
    });

    test('redacts messages and drops entries that still scan as secrets', () => {
      const dir = makeTempDir('diagnostics-errors-redact-');
      const body = [
        { level: 50, time: '2026-03-01T00:00:00.000Z', msg: `token ${FAKE_GITHUB_TOKEN}` },
        { level: 50, time: '2026-03-01T00:01:00.000Z', msg: `aws ${FAKE_AWS_KEY}` },
        { level: 50, time: '2026-03-01T00:02:00.000Z', msg: 'ordinary failure', err: { message: 'boom' } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n');
      writeLog(dir, 'orchestrator.log', `${body}\n`);

      const redacting = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const kept = redacting.recentErrors(10).errors;
      expect(kept.find((e) => e.message.includes('token'))?.message).not.toContain(FAKE_GITHUB_TOKEN);

      const failing = new DiagnosticsService({ db: dbHolder.db, logsDir: dir, redactor: identityRedactor });
      const dropped = failing.recentErrors(10).errors;
      expect(dropped.some((e) => e.message.includes(FAKE_GITHUB_TOKEN))).toBe(false);
      expect(dropped.some((e) => e.message.includes(FAKE_AWS_KEY))).toBe(false);
      expect(dropped.map((e) => e.message)).toEqual(['ordinary failure']);
      expect(dropped[0]?.detail).toBe('boom');
    });

    test('returns an empty list when logs are not configured', () => {
      const service = new DiagnosticsService({ db: dbHolder.db });
      expect(service.recentErrors(10)).toEqual({ errors: [], scannedFiles: 0 });
    });
  });

  // ── Health ───────────────────────────────────────────────────────────────

  describe('health', () => {
    test('reports all seven components, versions and DB stats', () => {
      const extra: Pick<DiagnosticsHealthComponents, 'opencode' | 'gateway' | 'github' | 'ollama'> = {
        opencode: { status: 'ok', detail: 'installed' },
        gateway: { status: 'ok', detail: 'listening' },
        github: { status: 'ok', detail: 'authenticated' },
        ollama: { status: 'ok', detail: 'reachable' },
      };
      const service = new DiagnosticsService({
        db: dbHolder.db,
        logsDir,
        backupsDir,
        version: '9.9.9',
        electronVersion: '1.2.3',
        extraComponents: () => extra,
      });

      const health = service.health();
      expect(Object.keys(health.components).sort()).toEqual(
        ['backups', 'db', 'gateway', 'github', 'logs', 'ollama', 'opencode'].sort(),
      );
      expect(health.status).toBe('ok');
      expect(health.versions).toEqual({ app: '9.9.9', node: process.version, electron: '1.2.3' });
      expect(health.memory.rssBytes).toBeGreaterThan(0);
      expect(health.memory.heapUsedBytes).toBeGreaterThan(0);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);

      const pageCount = Number(dbHolder.db.$client.pragma('page_count', { simple: true }));
      const pageSize = Number(dbHolder.db.$client.pragma('page_size', { simple: true }));
      expect(health.components.db).toEqual({
        status: 'ok',
        detail: 'database reachable',
        sizeBytes: pageCount * pageSize,
      });
      expect(health.components.logs.status).toBe('ok');
      expect(health.components.logs.fileCount).toBe(service.listLogs().length);
      expect(health.components.backups.latest).toBeNull();
    });

    test('is degraded when optional components are not configured', () => {
      const service = new DiagnosticsService({ db: dbHolder.db });
      const health = service.health();
      expect(health.status).toBe('degraded');
      expect(health.components.logs.status).toBe('unavailable');
      expect(health.components.backups.status).toBe('unavailable');
      expect(health.components.opencode).toEqual({ status: 'unavailable', detail: 'OpenCode not configured' });
      expect(health.components.ollama.detail).toBe('Ollama not configured');
    });

    test('reports a broken database without throwing', () => {
      const broken = {
        $client: {
          prepare: () => {
            throw new Error('db closed');
          },
        },
      } as unknown as AikDb;
      const service = new DiagnosticsService({ db: broken });
      const health = service.health();
      expect(health.status).toBe('degraded');
      expect(health.components.db).toEqual({
        status: 'degraded',
        detail: 'database check failed',
        sizeBytes: 0,
      });
    });
  });

  // ── Backups ──────────────────────────────────────────────────────────────

  describe('backups', () => {
    test('creates and lists a backup without leaking paths', async () => {
      const dir = makeTempDir('diagnostics-backup-create-');
      const now = new Date('2026-01-02T03:04:05.678Z');
      const service = new DiagnosticsService({ db: dbHolder.db, backupsDir: dir, now: () => now });

      const result = await service.createBackup();
      expect(result).toEqual({ ok: true, name: backupFileName(now), size: expect.any(Number) });
      if (!result.ok) throw new Error('expected backup');
      expect(result.size).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dir, result.name))).toBe(true);

      const listed = service.listBackups();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual({ name: result.name, size: result.size, modifiedAt: expect.any(String) });
      expect(Number.isFinite(Date.parse(listed[0]?.modifiedAt ?? ''))).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(dir);
    });

    test('lists only app-*.db regular files, newest first', () => {
      const dir = makeTempDir('diagnostics-backup-list-');
      const names = ['app-2020-01-01T00-00-00-000Z.db', 'app-2021-01-01T00-00-00-000Z.db'];
      names.forEach((name, index) => {
        const file = writeLog(dir, name, 'sqlite');
        const when = new Date(2020, 0, index + 1);
        fs.utimesSync(file, when, when);
      });
      writeLog(dir, 'app-broken.db.tmp', 'x');
      writeLog(dir, 'not-a-backup.db', 'x');
      fs.mkdirSync(path.join(dir, 'app-directory.db'));

      const service = new DiagnosticsService({ db: dbHolder.db, backupsDir: dir });
      expect(service.listBackups().map((b) => b.name)).toEqual([...names].reverse());
    });

    test('throttles repeated backups and returns a fixed reason', async () => {
      const dir = makeTempDir('diagnostics-backup-throttle-');
      const base = Date.parse('2026-05-01T00:00:00.000Z');
      const service = new DiagnosticsService({ db: dbHolder.db, backupsDir: dir });

      const first = await service.createBackup(new Date(base));
      expect(first.ok).toBe(true);
      expect(await service.createBackup(new Date(base + 1_000))).toEqual({ ok: false, reason: 'throttled' });
      expect(await service.createBackup(new Date(base + 9_999))).toEqual({ ok: false, reason: 'throttled' });
      expect((await service.createBackup(new Date(base + 10_000))).ok).toBe(true);
    });

    test('shares one in-flight backup between concurrent callers', async () => {
      const dir = makeTempDir('diagnostics-backup-singleflight-');
      const now = new Date('2026-06-01T00:00:00.000Z');
      const service = new DiagnosticsService({ db: dbHolder.db, backupsDir: dir, now: () => now });

      const [a, b] = await Promise.all([service.createBackup(), service.createBackup()]);
      expect(a).toEqual(b);
      expect(a.ok).toBe(true);
      expect(service.listBackups()).toHaveLength(1);
    });

    test('prunes old backups to the retention limit', async () => {
      const dir = makeTempDir('diagnostics-backup-prune-');
      for (let i = 0; i < 8; i += 1) {
        const file = writeLog(dir, `app-2020-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.db`, 'old');
        const when = new Date(2020, 0, i + 1);
        fs.utimesSync(file, when, when);
      }
      const service = new DiagnosticsService({ db: dbHolder.db, backupsDir: dir });
      const result = await service.createBackup(new Date('2026-07-01T00:00:00.000Z'));
      expect(result.ok).toBe(true);
      const listed = service.listBackups();
      expect(listed).toHaveLength(DIAGNOSTICS_MAX_BACKUPS);
      expect(listed[0]?.name).toBe(backupFileName(new Date('2026-07-01T00:00:00.000Z')));
    });

    test('never throws and maps failures to stable reasons', async () => {
      const withoutDir = new DiagnosticsService({ db: dbHolder.db });
      expect(await withoutDir.createBackup()).toEqual({ ok: false, reason: 'backups unavailable' });

      const fileAsDir = writeLog(makeTempDir('diagnostics-backup-bad-'), 'blocked', 'x');
      const failing = new DiagnosticsService({ db: dbHolder.db, backupsDir: fileAsDir });
      expect(await failing.createBackup()).toEqual({ ok: false, reason: 'backup failed' });
      expect(failing.listBackups()).toEqual([]);
    });
  });

  // ── Export ───────────────────────────────────────────────────────────────

  describe('exportArchive', () => {
    test('keeps the archive shape, adds DB stats and redacts log content', async () => {
      const dir = makeTempDir('diagnostics-export-');
      writeLog(dir, 'orchestrator.log', `${JSON.stringify({ msg: 'auth', token: FAKE_GITHUB_TOKEN })}\n`);
      const service = new DiagnosticsService({
        db: dbHolder.db,
        logsDir: dir,
        version: '0.1.0',
        electronVersion: '1.2.3',
      });

      const archive = await service.exportArchive();
      expect(archive.version).toBe('0.1.0');
      expect(Number.isFinite(Date.parse(archive.timestamp))).toBe(true);
      expect(archive.diagnostics.platform.os).toContain('(');
      expect(archive.diagnostics.platform.nodeVersion).toBe(process.version);
      expect(archive.diagnostics.projects.some((p) => p.name === 'Diagnostics Project')).toBe(true);
      expect(archive.diagnostics.providers).toEqual([]);
      expect(archive.diagnostics.logs.map((l) => l.file)).toEqual(['orchestrator.log']);

      const pageCount = Number(dbHolder.db.$client.pragma('page_count', { simple: true }));
      const pageSize = Number(dbHolder.db.$client.pragma('page_size', { simple: true }));
      expect(archive.diagnostics.database).toEqual({
        sizeBytes: pageCount * pageSize,
        pageCount,
        pageSize,
      });

      const serialized = JSON.stringify(archive);
      expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
      expect(serialized).toContain('[REDACTED:github-token]');
    });

    test('caps the archive to the newest 20 log files', async () => {
      const dir = makeTempDir('diagnostics-export-count-');
      const base = Date.parse('2026-08-01T00:00:00.000Z');
      for (let i = 0; i < 21; i += 1) {
        const name = `log-${String(i).padStart(2, '0')}.log`;
        const file = writeLog(dir, name, `${JSON.stringify({ level: 30, msg: name, pad: 'x'.repeat(100) })}\n`);
        const when = new Date(base + i * 1_000);
        fs.utimesSync(file, when, when);
      }
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const archive = await service.exportArchive();
      const files = archive.diagnostics.logs.map((l) => l.file);

      expect(files).toHaveLength(20);
      expect(files[0]).toBe('log-20.log');
      expect(files).not.toContain('log-00.log');
    });

    test('caps the total log payload at 2 MiB without reading whole files', async () => {
      const dir = makeTempDir('diagnostics-export-bytes-');
      const chunk = `${'y'.repeat(100)}\n`.repeat(3_000); // ~303 KB > the 256 KiB tail cap
      for (let i = 0; i < 10; i += 1) writeLog(dir, `big-${i}.log`, chunk);
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir });
      const archive = await service.exportArchive();

      const total = archive.diagnostics.logs.reduce((sum, log) => sum + Buffer.byteLength(log.content), 0);
      expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(archive.diagnostics.logs.length).toBeLessThan(10);
      expect(archive.diagnostics.logs.length).toBeGreaterThan(0);
    });

    test('fails closed when a log still matches a secret pattern', async () => {
      const dir = makeTempDir('diagnostics-export-failclosed-');
      writeLog(dir, 'orchestrator.log', `${FAKE_AWS_KEY}\n`);
      const service = new DiagnosticsService({ db: dbHolder.db, logsDir: dir, redactor: identityRedactor });
      await expect(service.exportArchive()).rejects.toThrow(/secret scanning/i);
    });

    test('works without a logs directory configured', async () => {
      const service = new DiagnosticsService({ db: dbHolder.db });
      const archive = await service.exportArchive();
      expect(archive.diagnostics.logs).toEqual([]);
      expect(archive.diagnostics.database.pageCount).toBeGreaterThan(0);
      expect(archive.diagnostics.database.sizeBytes).toBe(
        archive.diagnostics.database.pageCount * archive.diagnostics.database.pageSize,
      );
    });
  });
});
