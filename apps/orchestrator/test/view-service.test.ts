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

  it('expands the root commit\'s file list (--root)', async () => {
    const { svc, project } = await setup();
    const log = await svc.log(project.id);
    const root = log.commits[log.commits.length - 1]!;
    expect(root.parents).toEqual([]);
    const files = await svc.commitFiles(project.id, root.sha);
    expect(files.files).toEqual([{ path: 'README.md', change: 'A' }]);
  });

  it('rejects an unknown sha with 404 NOT_FOUND', async () => {
    const { svc, project } = await setup();
    await expect(svc.commitFiles(project.id, 'a'.repeat(40))).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('GitViewService.branches', () => {
  it('lists local + remote branches and the current one', async () => {
    // Brief deviation: makeTempRemoteAndClone returns { remote, clone } — the brief's original
    // `const { repo } = ...` left repo undefined, so the switch commands ran in the real working
    // repository. Destructure the clone so everything stays inside the OS temp dir, and pass a
    // track callback so the helper's separate seed/remote/clone temp roots are cleaned up too.
    const { clone: repo } = makeTempRemoteAndClone(tracked); // the clone's default branch is `trunk`
    const { svc, project } = await setup({ repo: tracked(repo) });
    gitIn(repo, 'switch', '-qc', 'feature/wing');
    gitIn(repo, 'switch', 'trunk');
    const b = await svc.branches(project.id);
    expect(b.current).toBe('trunk');
    expect(b.local).toContain('feature/wing');
    expect(b.remote.some((r) => r.startsWith('origin/'))).toBe(true);
  });
});

// Task 5: mutation describe block, appended after the existing describe sections per the brief.
// `await setup()` is used because ProjectService.create is async (same deviation as above).

describe('GitViewService.stage/unstage/commit/discard', () => {
  it('stages by path and by all, unstages back', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b');
    let s = await svc.stage(project.id, { paths: ['a.ts'] });
    expect(s.staged.map((f) => f.path)).toEqual(['a.ts']);
    s = await svc.stage(project.id, { all: true });
    expect(s.staged.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    s = await svc.unstage(project.id, { paths: ['a.ts'] });
    expect(s.staged.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('rejects committing with nothing staged (VALIDATION_FAILED)', async () => {
    const { svc, project } = await setup();
    await expect(svc.commit(project.id, { message: 'nothing yet' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await svc.status(project.id)).staged).toEqual([]);
  });

  it('commits staged work and clears the lists', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'one.ts'), '1');
    await svc.stage(project.id, { all: true });
    const s = await svc.commit(project.id, { message: 'first work' });
    expect(s.staged).toEqual([]);
    const log = await svc.log(project.id);
    expect(log.commits[0]!.subject).toBe('first work');
  });

  it('commits given paths directly (stage-then-commit)', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'direct.ts'), 'd');
    fs.writeFileSync(path.join(repo, 'left.ts'), 'l');
    const s = await svc.commit(project.id, { message: 'only direct', paths: ['direct.ts'] });
    expect(s.changes.map((f) => f.path)).toEqual(['left.ts']);
    expect(s.staged).toEqual([]);
    const log = await svc.log(project.id);
    expect(log.commits[0]!.subject).toBe('only direct');
  });

  it('fails with IDENTITY_MISSING when the repo has no user config', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'x.ts'), 'x');
    // Brief deviation (hermetic arrange): the brief's bare `config --unset user.name` exits 5 when
    // the repo has no local user.* key — execFileSync would throw — and a dev machine's global
    // identity would still satisfy the commit. Seed the local identity, unset it, and hide
    // global/system config for the git children the service spawns so the failure comes only from
    // the repo having no user config.
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      gitIn(repo, 'config', 'user.name', 'aik-test');
      gitIn(repo, 'config', 'user.email', 'aik-test@localhost');
      gitIn(repo, 'config', '--unset', 'user.name');
      gitIn(repo, 'config', '--unset', 'user.email');
      await svc.stage(project.id, { all: true });
      await expect(svc.commit(project.id, { message: 'anon' })).rejects.toMatchObject({ code: 'IDENTITY_MISSING' });
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    }
  });

  it('discards tracked (restore) and deletes untracked — after containment check', async () => {
    const { repo, svc, project } = await setup();
    // Brief deviation: makeTempRepo seeds only README.md, so `tracked.txt` is untracked as written
    // and `discard` would delete it — the brief's own final expectation (content back to `# test\n`)
    // would then hit a missing file. Track it first, then modify it so it lands as a tracked change.
    // Also pin core.autocrlf=false: Windows checkout (`git restore`) would otherwise rewrite the
    // file with CRLF, breaking the exact `# test\n` content assertion.
    gitIn(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), '# test\n');
    gitIn(repo, 'add', 'tracked.txt');
    gitIn(repo, 'commit', '-q', '-m', 'track it');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'v1');
    await svc.discard(project.id, { paths: ['untracked.txt'] });
    expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(false);
    await svc.discard(project.id, { paths: ['tracked.txt'] });
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('# test\n');
  });

  it('discards an untracked directory recursively (porcelain dir/ entry)', async () => {
    const { repo, svc, project } = await setup();
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'inner.txt'), 'i');
    let s = await svc.status(project.id);
    expect(s.changes.map((f) => f.path)).toContain('sub/'); // porcelain reports the directory entry
    s = await svc.discard(project.id, { paths: ['sub/'] });
    expect(fs.existsSync(path.join(repo, 'sub'))).toBe(false);
    expect(s.changes.map((f) => f.path)).toEqual([]);
  });

  it('rejects discard of a nonexistent path with VALIDATION_FAILED (no raw ENOENT)', async () => {
    const { svc, project } = await setup();
    await expect(svc.discard(project.id, { paths: ['missing.txt'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Path not found in repo: missing.txt',
    });
  });

  it('recovers a tracked worktree deletion the status already lists ( D, no on-disk existence)', async () => {
    const { repo, svc, project } = await setup();
    // Same autocrlf pin as the restore test above: Windows checkout must keep the exact LF content.
    gitIn(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'keep me\n');
    gitIn(repo, 'add', 'gone.txt');
    gitIn(repo, 'commit', '-q', '-m', 'track gone');
    fs.rmSync(path.join(repo, 'gone.txt'));
    let s = await svc.status(project.id);
    expect(s.changes.find((f) => f.path === 'gone.txt')).toMatchObject({ x: ' ', y: 'D' });
    // The deleted file is not on disk, so the realpath check would reject it — discard must run
    // git restore instead because the path comes from the status listing.
    s = await svc.discard(project.id, { paths: ['gone.txt'] });
    expect(fs.readFileSync(path.join(repo, 'gone.txt'), 'utf8')).toBe('keep me\n');
    expect(s.changes.map((f) => f.path)).toEqual([]);
  });

  it('refuses mutations while merge state is active', async () => {
    const { repo, svc, project } = await setup();
    // force MERGE_HEAD-like condition without a real merge: git merge with divergent branches
    gitIn(repo, 'switch', '-qc', 'side');
    fs.writeFileSync(path.join(repo, 'side.txt'), 's');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'side');
    gitIn(repo, 'switch', 'main');
    fs.writeFileSync(path.join(repo, 'main.txt'), 'm');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'main');
    gitIn(repo, 'merge', '--no-commit', 'side');
    await expect(svc.stage(project.id, { all: true })).rejects.toMatchObject({ code: 'MERGE_IN_PROGRESS' });
    await expect(svc.commit(project.id, { message: 'nope' })).rejects.toMatchObject({ code: 'MERGE_IN_PROGRESS' });
    expect(await svc.status(project.id)).toMatchObject({ mergeState: 'merge' });
    gitIn(repo, 'merge', '--abort');
  });
});

// Task 6: push/pull and branch checkout/create, appended after the existing describe sections.
// `await setup()` is used because ProjectService.create is async (same deviation as above).
// Both seeded "second user" repos rename their branch to `trunk` after reset (see below).

describe('GitViewService push/pull', () => {
  it('pushes to a local bare remote, sets upstream; pull fast-forwards', async () => {
    // Brief deviation: track the helper's seed/remote/clone temp roots too (same as the branches
    // test above — afterEach can only clean directories registered via `tracked`).
    const { remote, clone } = makeTempRemoteAndClone(tracked); // the clone's default branch is `trunk`
    const { svc, project } = await setup({ repo: tracked(clone) });
    fs.writeFileSync(path.join(clone, 'wing.txt'), 'w');
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-qm', 'wing');
    const pushed = await svc.push(project.id);
    expect(pushed.ahead).toBe(0);
    expect(pushed.upstream).toBe('origin/trunk');
    // simulate a second user pushing, then pull
    const seeded = makeTempRepo({ name: 'second-clone', track: tracked });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seeded });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: seeded });
    execFileSync('git', ['reset', '-q', '--hard', 'origin/trunk'], { cwd: seeded });
    // Brief deviation: makeTempRepo is frozen at `init -b main`, so the brief's `push origin trunk`
    // below failed with "src refspec trunk does not match any". Rename main to trunk after the
    // reset (mirroring the helper's bare-remote default) so the brief's push command stays verbatim.
    execFileSync('git', ['branch', '-m', 'trunk'], { cwd: seeded });
    fs.writeFileSync(path.join(seeded, 'second.txt'), 's2');
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'add', '.'], { cwd: seeded });
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'commit', '-qm', 'from second'], { cwd: seeded });
    execFileSync('git', ['push', '-q', 'origin', 'trunk'], { cwd: seeded });
    const pulled = await svc.pull(project.id);
    expect(fs.existsSync(path.join(clone, 'second.txt'))).toBe(true);
    expect(pulled.behind).toBe(0);
  });

  it('refuses pull with local changes (WORKING_TREE_DIRTY) and divergent history (DIVERGED)', async () => {
    const { remote, clone } = makeTempRemoteAndClone(tracked);
    const { repo, svc, project } = await setup({ repo: tracked(clone) });
    fs.writeFileSync(path.join(repo, 'local-change.txt'), 'x');
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'WORKING_TREE_DIRTY' });
    fs.rmSync(path.join(repo, 'local-change.txt'));
    const seeded = makeTempRepo({ name: 'diverge', track: tracked });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seeded });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: seeded });
    execFileSync('git', ['reset', '-q', '--hard', 'origin/trunk'], { cwd: seeded });
    execFileSync('git', ['branch', '-m', 'trunk'], { cwd: seeded }); // same Brief deviation as above
    fs.writeFileSync(path.join(seeded, 'diverge.txt'), 'd');
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'add', '.'], { cwd: seeded });
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'commit', '-qm', 'diverge'], { cwd: seeded });
    fs.writeFileSync(path.join(repo, 'own.txt'), 'o');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'own');
    execFileSync('git', ['push', '-q', 'origin', 'trunk'], { cwd: seeded });
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'DIVERGED' });
  });

  it('refuses when there is no origin remote', async () => {
    const { svc, project } = await setup();
    await expect(svc.push(project.id)).rejects.toMatchObject({ code: 'NO_REMOTE' });
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'NO_REMOTE' });
  });
});

describe('GitViewService branches: checkout/create', () => {
  it('creates and switches, refuses duplicates, respects check-ref-format', async () => {
    const { svc, project } = await setup();
    const created = await svc.createBranch(project.id, { name: 'story/feature' });
    expect(created.branch).toBe('story/feature');
    await expect(svc.createBranch(project.id, { name: 'story/feature' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
    await expect(svc.createBranch(project.id, { name: 'bad name..' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
    const back = await svc.checkout(project.id, { name: 'main' });
    expect(back.branch).toBe('main');
    await expect(svc.checkout(project.id, { name: 'origin/main' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
  });

  it('refuses checkout with uncommitted changes', async () => {
    const { repo, svc, project } = await setup();
    gitIn(repo, 'switch', '-qc', 'elsewhere');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'd');
    await expect(svc.checkout(project.id, { name: 'elsewhere' })).rejects.toMatchObject({ code: 'WORKING_TREE_DIRTY' });
  });
});
