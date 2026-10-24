// apps/orchestrator/test/git-view-routes.test.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';
import { makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('git view routes', () => {
  it('GET status works and stage/commit mutate with idempotency keys', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'routes' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'We Made Kits', key: 'WMK', repoPath: repo });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as number;
    const status = await inject('GET', `/projects/${id}/git/status`);
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ branch: 'main', agentBusy: false });
    fs.writeFileSync(path.join(repo, 'notes.md'), 'n');
    const stage = await inject('POST', `/projects/${id}/git/stage`, { all: true });
    expect(stage.statusCode).toBe(200);
    expect(JSON.parse(stage.body).staged).toHaveLength(1);
    const firstKey = crypto.randomUUID();
    const first = await inject('POST', `/projects/${id}/git/commit`, { message: 'route commit' }, firstKey);
    expect(first.statusCode).toBe(200);
    // same key + same body-hash replays the stored response instead of committing again
    fs.writeFileSync(path.join(repo, 'more.md'), 'm');
    await inject('POST', `/projects/${id}/git/stage`, { all: true });
    const replay = await inject('POST', `/projects/${id}/git/commit`, { message: 'route commit' }, firstKey);
    expect(replay.statusCode).toBe(200);
    const log = await inject('GET', `/projects/${id}/git/log?limit=5`);
    const commits = JSON.parse(log.body).commits.map((c: { subject: string }) => c.subject) as string[];
    expect(commits.filter((c: string) => c === 'route commit')).toHaveLength(1);
  });

  it('refuses mutations while the project is busy; reads still work', async () => {
    const { inject } = await buildTestApp({ fakeBusy: () => 'Story B-1 has an agent run' });
    const repo = makeTempRepo({ name: 'busy-routes' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'B', key: 'PB', repoPath: repo });
    const id = JSON.parse(created.body).id as number;
    const status = await inject('GET', `/projects/${id}/git/status`);
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body).agentBusy).toBe(true);
    const stage = await inject('POST', `/projects/${id}/git/stage`, { all: true });
    expect(stage.statusCode).toBe(409);
    expect(stage.json().error.code).toBe('PROJECT_BUSY');
  });

  it('rejects a hybrid stage body that mixes all and paths (Task-1 review follow-through)', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'hybrid-routes' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'H', key: 'HYB', repoPath: repo });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as number;
    const hybrid = await inject('POST', `/projects/${id}/git/stage`, { all: true, paths: ['x'] });
    expect(hybrid.statusCode).toBe(400);
    expect(hybrid.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a dashed branch-create start point with VALIDATION_FAILED', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'dashed-from' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'D', key: 'DSH', repoPath: repo });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as number;
    const res = await inject('POST', `/projects/${id}/git/branches/create`, { name: 'evil', from: '-evil' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a non-numeric log limit with VALIDATION_FAILED', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'bad-limit' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'L', key: 'LIM', repoPath: repo });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as number;
    const res = await inject('GET', `/projects/${id}/git/log?limit=abc`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
