// apps/orchestrator/test/view-service.test.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitViewService } from '../src/git/view-service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRemoteAndClone, makeTempRepo } from './helpers/temp.ts';
import { ProjectService } from '../src/projects/service.ts';
import { systemClock } from '../src/time.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tracked = (d: string) => {
  tempDirs.push(d);
  return d;
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', ...args], { cwd, encoding: 'utf8' });

async function setup(opts: { repo?: string } = {}) {
  const t = createTestDb();
  const repo = tracked(opts.repo ?? makeTempRepo({ name: 'wmk' }));
  const projects = new ProjectService({ db: t.db, now: systemClock });
  const svc = new GitViewService({ db: t.db, now: systemClock, projects });
  // Brief deviation: ProjectService.create is async, so setup must await it (tests otherwise read `project.id` undefined).
  const project = await projects.create({ name: 'We Made Kits', key: 'WMK', repoPath: repo });
  return { t, repo, svc, project };
}

describe('GitViewService.status', () => {
  it('reports a clean tree', async () => {
    const { svc, project } = await setup();
    const s = await svc.status(project.id);
    expect(s).toMatchObject({ projectId: project.id, branch: 'main', upstream: null, ahead: null, behind: null, staged: [], changes: [], mergeState: 'none', agentBusy: false });
    expect((s.headSha ?? '').length).toBe(40);
  });

  it('splits staged and unstaged lists and detects untracked files', async () => {
    const { repo, svc, project } = await setup();
    // Brief deviation: as written, `dirty.ts` is written once and never tracked — git would report
    // `?? dirty.ts`, making the brief's own expectation (x=' ', y='M') impossible. Track it first,
    // then modify it so it lands as ' M'; untracked detection stays covered by `stray.bin`.
    fs.writeFileSync(path.join(repo, 'dirty.ts'), 'y');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'tmp');
    fs.writeFileSync(path.join(repo, 'staged.ts'), 'x');
    gitIn(repo, 'add', 'staged.ts');
    fs.writeFileSync(path.join(repo, 'dirty.ts'), 'y2');
    fs.writeFileSync(path.join(repo, 'stray.bin'), 'z');
    const s = await svc.status(project.id);
    expect(s.staged.map((f) => f.path)).toEqual(['staged.ts']);
    expect(s.changes.map((f) => f.path).sort()).toEqual(['dirty.ts', 'stray.bin']);
    const dirty = s.changes.find((f) => f.path === 'dirty.ts')!;
    expect(dirty.x).toBe(' ');
    expect(dirty.y).toBe('M');
  });
});

describe('GitViewService.log + commitFiles', () => {
  it('lists recent commits newest first and expands a commit\'s files', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'two.txt'), '1');
    gitIn(repo, 'add', 'two.txt');
    gitIn(repo, 'commit', '-q', '-m', 'feat: second');
    const log = await svc.log(project.id);
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]!.subject).toBe('feat: second');
    const files = await svc.commitFiles(project.id, log.commits[0]!.sha);
    expect(files.files).toEqual([{ path: 'two.txt', change: 'A' }]);
  });
});

describe('GitViewService.branches', () => {
  it('lists local + remote branches and the current one', async () => {
    // Brief deviation: makeTempRemoteAndClone returns { remote, clone } — the brief's original
    // `const { repo } = ...` left repo undefined, so the switch commands ran in the real working
    // repository. Destructure the clone so everything stays inside the OS temp dir.
    const { clone: repo } = makeTempRemoteAndClone(); // the clone's default branch is `trunk`
    const { svc, project } = await setup({ repo: tracked(repo) });
    gitIn(repo, 'switch', '-qc', 'feature/wing');
    gitIn(repo, 'switch', 'trunk');
    const b = await svc.branches(project.id);
    expect(b.current).toBe('trunk');
    expect(b.local).toContain('feature/wing');
    expect(b.remote.some((r) => r.startsWith('origin/'))).toBe(true);
  });
});
