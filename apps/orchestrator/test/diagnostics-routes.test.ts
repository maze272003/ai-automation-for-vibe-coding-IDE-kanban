// apps/orchestrator/test/diagnostics-routes.test.ts
//
// W0 Task 16: the /diagnostics routes served by registerMaintenanceRoutes via
// buildTestApp. Every log/backups directory is an OS temp dir (helpers/temp.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';

const json = (r: { body: string }) => JSON.parse(r.body);
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('W0-6 diagnostics routes', () => {
  it('GET /diagnostics/health returns the component health DTO', async () => {
    const { inject } = await buildTestApp();
    const res = await inject('GET', '/diagnostics/health');
    expect(res.statusCode).toBe(200);
    const health = json(res);
    expect(['ok', 'degraded']).toContain(health.status);
    expect(typeof health.uptimeSeconds).toBe('number');
    expect(health.versions).toMatchObject({ app: expect.any(String), node: expect.any(String), electron: null });
    expect(health.memory).toMatchObject({ rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) });
    for (const name of ['db', 'logs', 'backups', 'opencode', 'gateway', 'github', 'ollama']) {
      expect(health.components[name]).toMatchObject({
        status: expect.stringMatching(/^(ok|degraded|unavailable)$/),
        detail: expect.any(String),
      });
    }
    expect(health.components.db.status).toBe('ok');
  });

  it('GET /diagnostics/logs lists the log files in the temp logs dir', async () => {
    const { inject, logsDir } = await buildTestApp();
    fs.writeFileSync(path.join(logsDir, 'orchestrator.log'), 'line\n');
    const res = await inject('GET', '/diagnostics/logs');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ name: 'orchestrator.log', size: 5, modifiedAt: expect.any(String) });
  });

  it('GET /diagnostics/logs/:file returns redacted content; unknown 404; invalid name/tail 400', async () => {
    const { inject, logsDir } = await buildTestApp();
    fs.writeFileSync(path.join(logsDir, 'orchestrator.log'), `${JSON.stringify({ msg: `call failed with ${FAKE_AWS_KEY}` })}\n`);

    const res = await inject('GET', '/diagnostics/logs/orchestrator.log');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ name: 'orchestrator.log', redacted: true, truncated: false });
    expect(body.content).toContain('[REDACTED:aws-key]');
    expect(body.content).not.toContain(FAKE_AWS_KEY);

    const missing = await inject('GET', '/diagnostics/logs/missing.log');
    expect(missing.statusCode).toBe(404);
    expect(json(missing).error.code).toBe('NOT_FOUND');

    for (const url of [`/diagnostics/logs/${encodeURIComponent('../x')}`, '/diagnostics/logs/notes.txt']) {
      const bad = await inject('GET', url);
      expect(bad.statusCode).toBe(400);
      expect(json(bad).error.code).toBe('VALIDATION_FAILED');
    }

    const badTail = await inject('GET', '/diagnostics/logs/orchestrator.log?tailBytes=1');
    expect(badTail.statusCode).toBe(400);
    expect(json(badTail).error.code).toBe('VALIDATION_FAILED');
  });

  it('GET /diagnostics/errors returns recent redacted errors and validates the limit', async () => {
    const { inject, logsDir } = await buildTestApp();
    fs.writeFileSync(
      path.join(logsDir, 'orchestrator.log'),
      [
        JSON.stringify({ level: 50, time: Date.parse('2026-03-04T05:06:07.000Z'), msg: `upstream rejected key ${FAKE_AWS_KEY}` }),
        JSON.stringify({ level: 30, time: Date.now(), msg: 'info line' }),
        '',
      ].join('\n'),
    );
    const res = await inject('GET', '/diagnostics/errors?limit=10');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.scannedFiles).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({ file: 'orchestrator.log', level: 'error', time: '2026-03-04T05:06:07.000Z' });
    expect(body.errors[0].message).toContain('[REDACTED:aws-key]');
    expect(body.errors[0].message).not.toContain(FAKE_AWS_KEY);

    const badLimit = await inject('GET', '/diagnostics/errors?limit=0');
    expect(badLimit.statusCode).toBe(400);
    expect(json(badLimit).error.code).toBe('VALIDATION_FAILED');
  });

  it('POST /diagnostics/backup creates a backup that GET /diagnostics/backups lists', async () => {
    const { inject } = await buildTestApp();
    const created = await inject('POST', '/diagnostics/backup', {});
    expect(created.statusCode).toBe(200);
    const result = json(created);
    expect(result).toMatchObject({ ok: true, name: expect.any(String), size: expect.any(Number) });
    expect(result.name).toMatch(/^app-.*\.db$/);

    const list = await inject('GET', '/diagnostics/backups');
    expect(list.statusCode).toBe(200);
    const body = json(list);
    expect(body.backups).toHaveLength(1);
    expect(body.backups[0]).toMatchObject({ name: result.name, size: result.size, modifiedAt: expect.any(String) });
    expect(typeof body.restoreNote).toBe('string');
  });
});
