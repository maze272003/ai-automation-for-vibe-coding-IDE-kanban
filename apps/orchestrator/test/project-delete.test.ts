// apps/orchestrator/test/project-delete.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRuns, storyEvents } from '@aik/db';
import { purgeProjectData } from '../src/projects/purge-repo.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { ProjectService } from '../src/projects/service.ts';
import { buildTestApp } from './helpers/app.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('DELETE /projects/:id (sanctioned purge)', () => {
  it('removes the project row and its stories but not the folder on disk', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'purge-me' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'X', key: 'PX', repoPath: repo });
    const id = JSON.parse(created.body).id as number;
    const res = await inject('DELETE', `/projects/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stories: 0, discardedWorktrees: [] });
    expect((await inject('GET', `/projects/${id}`)).statusCode).toBe(404);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# test\n');
  });

  it('refuses while an agent run is active, naming the story (PROJECT_BUSY)', async () => {
    const { inject, t } = await buildTestApp();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(agentRuns).values({
      storyId: s.id, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0',
      idempotencyKey: 'k-del-1', status: 'running', startedAt: new Date(1_700_000_000_000),
    }).run();
    const res = await inject('DELETE', `/projects/${p.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_BUSY');
    expect(res.json().error.message).toContain(s.key);
  });
});

describe('purgeProjectData (unit, append-only evidence)', () => {
  it('purges stories + append-only rows; the no-delete triggers are recreated afterwards', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(storyEvents).values({ storyId: s.id, type: 'create', actor: 'human', createdAt: new Date(1_700_000_000_000) }).run();
    // direct DELETE must fail while the append-only trigger is armed
    expect(() => t.db.$client.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
    const { stories } = purgeProjectData(t.db, p.id);
    expect(stories).toBe(1);
    // the trigger must be recreated inside the same transaction — fresh writes keep working:
    const fresh = seedProject(t.db);
    const s2 = seedStory(t.db, fresh.id);
    t.db.insert(storyEvents).values({ storyId: s2.id, type: 'create', actor: 'human', createdAt: new Date(1_700_000_000_000) }).run();
    expect(() => t.db.$client.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
  });
});

describe('ProjectService.delete with a real worktree manager (temp root)', () => {
  it('removes app worktrees but not the repo folder', async () => {
    const t = createTestDb();
    const now = () => 1_700_000_000_000; // Clock is () => number; the plan's `() => new Date(...)` form fails typecheck
    const wtRoot = makeTempDir('aikanban-test-wt2-');
    const repo = makeTempRepo({ name: 'with-wt' });
    tempDirs.push(wtRoot, path.dirname(repo));
    const mgr = new WorktreeManager({ rootDir: wtRoot, db: t.db, now });
    const svc = new ProjectService({ db: t.db, now, worktreePurge: (input) => mgr.purgeForProject(input) });
    const created = await svc.create({ name: 'WT', key: 'WT', repoPath: repo });
    const story = seedStory(t.db, created.id);
    const ws = await mgr.ensureStoryWorktree({ repoPath: repo, storyKey: 'WT-1', baseBranch: 'main', storyId: story.id });
    const result = await svc.delete(created.id);
    expect(result.ok).toBe(true);
    expect(result.discardedWorktrees).toHaveLength(1);
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    expect(() => svc.get(created.id)).toThrow(/not found/i);
  });
});
