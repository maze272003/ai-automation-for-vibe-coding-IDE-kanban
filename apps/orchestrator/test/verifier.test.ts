import { defaultProjectSettings } from '@aik/contracts';
import { userStories, verificationChecks, verificationRuns } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { VerificationRunner } from '../src/verify/runner.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('VerificationRunner', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-verif-wt-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('runs mandatory checks and transitions story from TESTING to READY_FOR_REVIEW', async () => {
    const repoPath = makeTempRepo({ name: 'verif-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [
          { key: 'test-check', command: 'git status', mandatory: true, timeoutSec: 10 },
        ],
      },
    });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'VER-1',
      baseBranch: 'main',
    });

    // Create a commit on the worktree
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'hello world\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: file'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'VER-1',
      title: 'Verify me',
      status: 'TESTING',
      candidateSha,
      candidateTree,
    });

    const verifier = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-logs-'),
    });

    const result = await verifier.verifyStory(story.id);

    expect(result.ok).toBe(true);
    expect(result.passed).toBe(true);

    // Verification run and check records created
    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    expect(run?.status).toBe('passed');
    expect(run?.commitSha).toBe(candidateSha);

    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, run!.id)).all();
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.checkKey)).toEqual(['secrets', 'test-check']);
    expect(checks.every((c) => c.status === 'passed')).toBe(true);

    // Story transitioned to READY_FOR_REVIEW
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('READY_FOR_REVIEW');
  });

  test('fails when mandatory check exits non-zero and does not advance to READY_FOR_REVIEW', async () => {
    const repoPath = makeTempRepo({ name: 'verif-fail-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [
          { key: 'failing-check', command: 'git log non_existent_ref_12345', mandatory: true, timeoutSec: 10 },
        ],
      },
    });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'VER-2',
      baseBranch: 'main',
    });

    fs.writeFileSync(path.join(worktreePath, 'fail.txt'), 'fail\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: fail'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'VER-2',
      title: 'Fail me',
      status: 'TESTING',
      candidateSha,
      candidateTree,
    });

    const verifier = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-logs-'),
    });

    const result = await verifier.verifyStory(story.id);

    expect(result.ok).toBe(false);
    expect(result.passed).toBe(false);

    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).not.toBe('READY_FOR_REVIEW');
  });

  test('discards evidence and stays in TESTING when a mandatory check moves HEAD', async () => {
    const repoPath = makeTempRepo({ name: 'verif-mutate-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [
          {
            key: 'mutate',
            command: 'git -c user.name=aik -c user.email=aik@localhost commit --allow-empty -m mutate',
            mandatory: true,
            timeoutSec: 10,
          },
        ],
      },
    });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'VER-3',
      baseBranch: 'main',
    });

    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'mutate me\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: mutate'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'VER-3',
      title: 'Mutating check',
      status: 'TESTING',
      candidateSha,
      candidateTree,
    });

    const verifier = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-logs-'),
    });

    const result = await verifier.verifyStory(story.id);

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      verificationRunId: expect.any(Number),
      error: 'HEAD changed while checks were running; evidence was discarded',
    });

    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    expect(run?.status).toBe('error');
    expect(run?.commitSha).toBe(candidateSha);
    expect(run?.endedAt).toBeInstanceOf(Date);

    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('TESTING');
  });
});
