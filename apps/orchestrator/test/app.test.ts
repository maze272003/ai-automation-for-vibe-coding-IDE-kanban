// apps/orchestrator/test/app.test.ts
import { DatabaseCorruptError, durableJobs, openDatabase } from '@aik/db';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/app.ts';
import { MIGRATIONS, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const token = 'z'.repeat(43);
const opts = (dataDir: string) => ({ dataDir, token, migrationsFolder: MIGRATIONS, versions: { app: '0.1.0', electron: null }, heartbeatMs: 1000 });
const call = (port: number, method: string, p: string, body?: object) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('startOrchestrator', () => {
  it('serves the API, persists across restarts, backs up on restart and never logs the token', async () => {
    const dataDir = makeTempDir();
    let o = await startOrchestrator(opts(dataDir));
    expect((await call(o.port, 'GET', '/health')).status).toBe(200);
    expect((await call(o.port, 'POST', '/projects', { name: 'A', key: 'AA', repoPath: makeTempRepo() })).status).toBe(201);
    await o.close();

    o = await startOrchestrator(opts(dataDir));
    expect(await (await call(o.port, 'GET', '/projects')).json()).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1);
    await o.close();

    const log = fs.readFileSync(path.join(dataDir, 'logs', 'orchestrator.log'), 'utf8');
    expect(log).toContain('orchestrator listening');
    expect(log).not.toContain(token);
  });

  it('refuses to start on a corrupt database', async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'app.db'), 'garbage '.repeat(500));
    await expect(startOrchestrator(opts(dataDir))).rejects.toBeInstanceOf(DatabaseCorruptError);
  });

  it('blocks stories whose side-effecting job was interrupted by a crash (never re-runs it)', async () => {
    const dataDir = makeTempDir();
    const pre = openDatabase({ file: path.join(dataDir, 'app.db'), backupsDir: path.join(dataDir, 'backups'), migrationsFolder: MIGRATIONS });
    const story = seedStory(pre.db, seedProject(pre.db).id, { status: 'IN_PROGRESS' });
    const past = new Date(Date.now() - 3_600_000);
    pre.db.insert(durableJobs).values({
      kind: 'implement', slot: 'heavy', storyId: story.id, payload: {}, sideEffecting: true, status: 'leased', leaseToken: 'old',
      leaseExpiresAt: past, attempts: 1, runAfter: past, idempotencyKey: 'crashed', createdAt: past, updatedAt: past,
    }).run();
    pre.close();

    const o = await startOrchestrator(opts(dataDir));
    const dto = await (await call(o.port, 'GET', `/stories/${story.id}`)).json();
    expect(dto).toMatchObject({ status: 'BLOCKED', blocked: { reason: 'interrupted', from: 'IN_PROGRESS' } });
    await o.close();
  });

  it('serves GitHub settings and connection endpoints', async () => {
    const dataDir = makeTempDir();
    const o = await startOrchestrator(opts(dataDir));

    const s1 = await (await call(o.port, 'GET', '/github/settings')).json();
    expect(s1).toEqual({ clientId: null });

    const s2 = await (await call(o.port, 'PATCH', '/github/settings', { clientId: 'Iv1.test_client_id_123' })).json();
    expect(s2).toEqual({ clientId: 'Iv1.test_client_id_123' });

    const conn = await (await call(o.port, 'GET', '/github/connection')).json();
    expect(conn).toBeNull();

    await o.close();
  });
});
