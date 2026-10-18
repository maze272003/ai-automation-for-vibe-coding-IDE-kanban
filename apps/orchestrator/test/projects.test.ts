// apps/orchestrator/test/projects.test.ts
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProjectRoutes } from '../src/api/routes/projects.ts';
import { createApiServer } from '../src/api/server.ts';
import { ProjectService } from '../src/projects/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempDir, makeTempRemoteAndClone, makeTempRepo } from './helpers/temp.ts';

const TOKEN = 'p'.repeat(43);
const PORT = 41235;
let t: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiServer>;
let projects: ProjectService;

beforeEach(async () => {
  t = createTestDb();
  projects = new ProjectService({ db: t.db, now: () => 1_000 });
  app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now: () => 1_000, projects });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

const h = (mut = false) => ({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(mut ? { 'idempotency-key': crypto.randomUUID() } : {}) });
const create = (payload: object) => app.inject({ method: 'POST', url: '/projects', headers: h(true), payload });

describe('POST /projects', () => {
  it('registers a local repo with defaults', async () => {
    const repo = makeTempRepo();
    const r = await create({ name: 'Inventory', key: 'INV', repoPath: repo });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ key: 'INV', name: 'Inventory', baseBranch: 'main', remoteUrl: null, status: 'active', settings: { maxAttempts: 3 } });
    expect(r.json().repoPath.toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
  });

  it('stores the repository root when given a subfolder', async () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, 'src'));
    const r = await create({ name: 'A', key: 'AA', repoPath: path.join(repo, 'src') });
    expect(r.json().repoPath.toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
  });

  it('detects the remote default branch and strips credentials from the remote URL', async () => {
    const { clone } = makeTempRemoteAndClone();
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://user:s3cret@example.com/o/r.git'], { cwd: clone });
    const r = await create({ name: 'C', key: 'CC', repoPath: clone });
    expect(r.json()).toMatchObject({ baseBranch: 'trunk', remoteUrl: 'https://example.com/o/r.git' });
  });

  it('rejects non-git folders, relative paths and missing folders', async () => {
    const plain = makeTempDir();
    for (const repoPath of [plain, 'relative\\path', path.join(plain, 'missing')]) {
      const r = await create({ name: 'X', key: 'XX', repoPath });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects duplicate keys', async () => {
    await create({ name: 'A', key: 'DUP', repoPath: makeTempRepo() });
    expect((await create({ name: 'B', key: 'DUP', repoPath: makeTempRepo() })).statusCode).toBe(400);
  });

  it('rejects the same repo spelled differently', async () => {
    const repo = makeTempRepo();
    await create({ name: 'A', key: 'ONE', repoPath: repo });
    const r = await create({ name: 'B', key: 'TWO', repoPath: `${repo.toUpperCase()}\\` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/already registered/);
  });

  it('accepts paths with spaces and non-ASCII', async () => {
    const repo = makeTempRepo({ name: 'My Repos Zoë app' });
    const r = await create({ name: 'Zoë', key: 'ZOE', repoPath: repo });
    expect(r.statusCode).toBe(201);
    expect(r.json().repoPath).toContain('Zoë');
  });
});

describe('GET/PATCH /projects', () => {
  it('lists, reads and patches settings', async () => {
    const created = (await create({ name: 'A', key: 'AB', repoPath: makeTempRepo() })).json();
    expect((await app.inject({ method: 'GET', url: '/projects', headers: h() })).json()).toHaveLength(1);
    const settings = { ...created.settings, maxAttempts: 5 };
    const p = await app.inject({ method: 'PATCH', url: `/projects/${created.id}`, headers: h(true), payload: { settings } });
    expect(p.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/projects/${created.id}`, headers: h() })).json().settings.maxAttempts).toBe(5);
    expect((await app.inject({ method: 'GET', url: '/projects/999', headers: h() })).statusCode).toBe(404);
  });

  it('marks a moved repository unavailable and back to active', async () => {
    const repo = makeTempRepo();
    const created = (await create({ name: 'A', key: 'MV', repoPath: repo })).json();
    fs.renameSync(repo, `${repo}-moved`);
    await projects.refreshAvailability();
    expect(projects.get(created.id).status).toBe('unavailable');
    fs.renameSync(`${repo}-moved`, repo);
    await projects.refreshAvailability();
    expect(projects.get(created.id).status).toBe('active');
  });
});
