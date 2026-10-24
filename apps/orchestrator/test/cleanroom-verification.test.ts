import { defaultProjectSettings } from '@aik/contracts';
import { userStories, verificationRuns } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { installCleanDependencies } from '../src/verify/cleanroom.ts';
import { VerificationRunner } from '../src/verify/runner.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('REL-4 Clean-Room Verification', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({
      rootDir: makeTempDir('aikanban-cleanroom-worktrees-'),
      db: dbHolder.db,
    });
  });

  afterAll(() => {
    dbHolder.close();
  });

  const commitInStory = (worktreePath: string, file: string, content: string, message: string) => {
    const filePath = path.join(worktreePath, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', message], { cwd: worktreePath });
    return {
      baseSha: execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
      candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
      candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    };
  };

  test('WorktreeManager creates and removes cleanroom worktree at candidate SHA', async () => {
    const repoPath = makeTempRepo({ name: 'cleanroom-wt-repo' });
    const project = seedProject(dbHolder.db, { repoPath });
    const { worktreePath: storyWt } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'CLR-1', baseBranch: 'main' });
    const { candidateSha } = commitInStory(storyWt, 'file.txt', 'hello\n', 'feat: cleanroom test');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'CLR-1',
      title: 'Cleanroom Worktree',
      status: 'TESTING',
      candidateSha,
    });

    const cleanroomPath = await worktreeManager.ensureCleanroomWorktree({
      repoPath,
      storyKey: 'CLR-1',
      candidateSha,
      storyId: story.id,
    });

    expect(fs.existsSync(cleanroomPath)).toBe(true);
    expect(cleanroomPath).toContain('CLR-1.clean');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cleanroomPath, encoding: 'utf8' }).trim();
    expect(head).toBe(candidateSha);

    await worktreeManager.removeCleanroomWorktree({ repoPath, storyKey: 'CLR-1' });
    expect(fs.existsSync(cleanroomPath)).toBe(false);
  });

  test('installCleanDependencies detects lockfile and runs clean installation command', async () => {
    const targetDir = makeTempDir('cleanroom-install-');
    fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({ name: 'test-pkg' }));
    fs.writeFileSync(path.join(targetDir, 'package-lock.json'), JSON.stringify({ name: 'test-pkg', lockfileVersion: 3 }));

    // Custom runner/mock for testing without invoking real external registry
    const res = await installCleanDependencies(targetDir, {
      runner: async (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => ({
        exitCode: 0,
        stdout: Buffer.from(`ran ${cmd} ${args.join(' ')} in ${opts.cwd}`),
        stderr: Buffer.from(''),
      }),
    });

    expect(res.ok).toBe(true);
    expect(res.command).toContain('npm ci');
    expect(res.stdout).toContain('npm ci');
  });

  test('clean-room verification detects hidden local node_modules drift and fails candidate', async () => {
    const repoPath = makeTempRepo({ name: 'cleanroom-drift-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: {
        ...defaultProjectSettings(),
        cleanroomVerification: true,
        checks: [
          {
            key: 'dep-check',
            // Check requires node_modules/dep/ok.txt to pass
            command: 'node -e "process.exit(require(\'node:fs\').existsSync(\'node_modules/dep/ok.txt\') ? 0 : 1)"',
            mandatory: true,
            timeoutSec: 10,
          },
        ],
      },
    });

    const { worktreePath: storyWt } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'CLR-2', baseBranch: 'main' });

    // Simulate local uncommitted node_modules drift in story worktree:
    const driftPath = path.join(storyWt, 'node_modules', 'dep');
    fs.mkdirSync(driftPath, { recursive: true });
    fs.writeFileSync(path.join(driftPath, 'ok.txt'), 'present-in-story-worktree-only');

    // Add lockfile and commit legitimate changes (which do NOT track node_modules because it is gitignored)
    fs.writeFileSync(path.join(storyWt, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(storyWt, 'package.json'), JSON.stringify({ name: 'test-proj' }));
    fs.writeFileSync(path.join(storyWt, 'package-lock.json'), JSON.stringify({ name: 'test-proj', lockfileVersion: 3 }));
    const candidate = commitInStory(storyWt, 'index.js', 'console.log("drift test");\n', 'feat: candidate with local drift');

    const story = seedStory(dbHolder.db, project.id, {
      key: 'CLR-2',
      title: 'Drift Test',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const runner = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-cleanroom-drift-logs-'),
      // In cleanroom, install runs clean dependencies (which does not copy local untracked node_modules)
      cleanInstallRunner: async (_worktreePath: string) => {
        // Simulates clean install that doesn't produce the uncommitted ok.txt
        return { ok: true, command: 'npm ci', stdout: 'clean install ok', stderr: '', exitCode: 0 };
      },
    });

    const result = await runner.verifyStory(story.id);

    // Should fail because in clean-room worktree node_modules/dep/ok.txt does not exist
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');

    // Verification run with trigger 'cleanroom' must be recorded as failed
    const cleanroomRun = dbHolder.db
      .select()
      .from(verificationRuns)
      .where(and(eq(verificationRuns.storyId, story.id), eq(verificationRuns.trigger, 'cleanroom')))
      .get();
    expect(cleanroomRun).toBeDefined();
    expect(cleanroomRun?.status).toBe('failed');

    // Story remains in TESTING, not transitioned to AWAITING_REVIEW
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('TESTING');
  });

  test('clean-room verification passes and records cleanroom evidence when dependencies are clean', async () => {
    const repoPath = makeTempRepo({ name: 'cleanroom-pass-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: {
        ...defaultProjectSettings(),
        cleanroomVerification: true,
        checks: [
          {
            key: 'unit-tests',
            command: 'node -e "process.exit(0)"',
            mandatory: true,
            timeoutSec: 10,
          },
        ],
      },
    });

    const { worktreePath: storyWt } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'CLR-3', baseBranch: 'main' });
    fs.writeFileSync(path.join(storyWt, 'package.json'), JSON.stringify({ name: 'clean-proj' }));
    fs.writeFileSync(path.join(storyWt, 'package-lock.json'), JSON.stringify({ name: 'clean-proj', lockfileVersion: 3 }));
    const candidate = commitInStory(storyWt, 'src/main.js', 'console.log("clean");\n', 'feat: valid candidate');

    const story = seedStory(dbHolder.db, project.id, {
      key: 'CLR-3',
      title: 'Cleanroom Success',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const runner = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-cleanroom-pass-logs-'),
      cleanInstallRunner: async () => ({ ok: true, command: 'npm ci', stdout: 'installed', stderr: '', exitCode: 0 }),
    });

    const result = await runner.verifyStory(story.id);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('passed');

    // Both candidate and cleanroom runs must exist and pass
    const runs = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).all();
    expect(runs.some((r) => r.trigger === 'candidate' && r.status === 'passed')).toBe(true);
    expect(runs.some((r) => r.trigger === 'cleanroom' && r.status === 'passed')).toBe(true);

    // Story transitioned
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('READY_FOR_REVIEW');
  });
});
