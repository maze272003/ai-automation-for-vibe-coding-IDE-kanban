import { defaultProjectSettings } from '@aik/contracts';
import { userStories, verificationChecks, verificationRuns } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { VerificationRunner } from '../src/verify/runner.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

/** A check command that exits 0 but moves the worktree HEAD — evidence integrity must survive it. */
const MUTATE_HEAD_COMMAND = 'git -c user.name=aik -c user.email=aik@localhost commit --allow-empty -m mutate';

describe('VerificationRunner evidence rules', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-verif-rules-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  const verifier = () =>
    new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-verif-logs-'),
    });

  const candidateFor = async (repoPath: string, storyKey: string, file: string, content: string) => {
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey, baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, file), content);
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', `feat: ${storyKey}`], { cwd: worktreePath });
    return {
      worktreePath,
      candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
      candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    };
  };

  test('refuses to record evidence when HEAD is not the candidate', async () => {
    const repoPath = makeTempRepo({ name: 'verif-head-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [{ key: 'ok', command: 'git status', mandatory: true, timeoutSec: 10 }] },
    });
    await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'VRF-1', baseBranch: 'main' });
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-1',
      title: 'Wrong head',
      status: 'TESTING',
      candidateSha: 'a'.repeat(40),
      candidateTree: 'b'.repeat(40),
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(result.error).toMatch(/does not match candidate/);
    expect(dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).all()).toHaveLength(0);
  });

  test('refuses to record evidence when the worktree is dirty', async () => {
    const repoPath = makeTempRepo({ name: 'verif-dirty-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [{ key: 'ok', command: 'git status', mandatory: true, timeoutSec: 10 }] },
    });
    const candidate = await candidateFor(repoPath, 'VRF-2', 'a.txt', 'a\n');
    fs.writeFileSync(path.join(candidate.worktreePath, 'untracked.txt'), 'dirty\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-2',
      title: 'Dirty',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: false, status: 'error' });
    expect(result.error).toMatch(/uncommitted changes/);
    expect(dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).all()).toHaveLength(0);
  });

  test('requires checks or an explicit secrets-only acceptance', async () => {
    const repoPath = makeTempRepo({ name: 'verif-nochecks-repo' });
    const project = seedProject(dbHolder.db, { repoPath, settings: { ...defaultProjectSettings(), checks: [] } });
    const candidate = await candidateFor(repoPath, 'VRF-3', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-3',
      title: 'No checks',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: false, status: 'error', blockedReason: 'environment' });
    expect(dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).all()).toHaveLength(0);
  });

  test('passes secrets-only verification when the human accepted it', async () => {
    const repoPath = makeTempRepo({ name: 'verif-secretsonly-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [], secretsOnlyVerification: true },
    });
    const candidate = await candidateFor(repoPath, 'VRF-4', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-4',
      title: 'Secrets only',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: true, status: 'passed', passed: true });
    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, run!.id)).all();
    expect(checks).toEqual([expect.objectContaining({ checkKey: 'secrets', status: 'passed' })]);
  });

  test('fails when the candidate contains a secret, even if project checks pass', async () => {
    const repoPath = makeTempRepo({ name: 'verif-secret-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [{ key: 'ok', command: 'git status', mandatory: true, timeoutSec: 10 }] },
    });
    const candidate = await candidateFor(repoPath, 'VRF-5', 'config.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`);
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-5',
      title: 'Secret',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: false, status: 'failed', passed: false });
    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    expect(run?.status).toBe('failed');
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, run!.id)).all();
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkKey: 'secrets', mandatory: true, status: 'failed' }),
        expect.objectContaining({ checkKey: 'ok', mandatory: true, status: 'passed' }),
      ]),
    );
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
  });

  test('blocks the environment when a mandatory check cannot be run', async () => {
    const repoPath = makeTempRepo({ name: 'verif-unsupported-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: {
        ...defaultProjectSettings(),
        checks: [{ key: 'unsafe', command: 'npm test && whoami', mandatory: true, timeoutSec: 10 }],
      },
    });
    const candidate = await candidateFor(repoPath, 'VRF-7', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-7',
      title: 'Unsupported mandatory check',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: false, status: 'error', blockedReason: 'environment' });
    expect(result.error).toMatch(/unsafe \(unsupported\)/);
    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    expect(run?.status).toBe('error');
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, run!.id)).all();
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ checkKey: 'unsafe', mandatory: true, status: 'unsupported' })]),
    );
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
  });

  test('an unsupported or failed non-mandatory check is recorded without failing the run', async () => {
    const repoPath = makeTempRepo({ name: 'verif-optional-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: {
        ...defaultProjectSettings(),
        checks: [
          { key: 'optional', command: 'npm test && whoami', mandatory: false, timeoutSec: 10 },
          { key: 'required', command: 'git status', mandatory: true, timeoutSec: 10 },
        ],
      },
    });
    const candidate = await candidateFor(repoPath, 'VRF-6', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-6',
      title: 'Optional',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: true, status: 'passed' });
    const run = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).get();
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, run!.id)).all();
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkKey: 'optional', mandatory: false, status: 'unsupported' }),
        expect.objectContaining({ checkKey: 'required', mandatory: true, status: 'passed' }),
      ]),
    );
  });

  test('post-merge verification discards evidence when a check moves HEAD', async () => {
    const repoPath = makeTempRepo({ name: 'verif-postmutate-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: {
        ...defaultProjectSettings(),
        checks: [{ key: 'mutate', command: MUTATE_HEAD_COMMAND, mandatory: true, timeoutSec: 10 }],
      },
    });
    const mergedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
    const mergedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoPath, encoding: 'utf8' }).trim();
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-8',
      title: 'Post-merge mutation',
      status: 'AWAITING_MERGE',
      candidateSha: mergedSha,
      candidateTree: mergedTree,
    });

    const result = await verifier().verifyPostMerge({ storyId: story.id, mergedSha });

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      verificationRunId: expect.any(Number),
      error: 'HEAD changed while checks were running; evidence was discarded',
    });
    const runs = dbHolder.db
      .select()
      .from(verificationRuns)
      .where(and(eq(verificationRuns.storyId, story.id), eq(verificationRuns.commitSha, mergedSha)))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs.map((r) => r.status)).toEqual(['error']);
    expect(runs[0]?.endedAt).toBeInstanceOf(Date);
    // No false pass: there is no passed post-merge evidence for this merged SHA.
    expect(
      dbHolder.db
        .select()
        .from(verificationRuns)
        .where(and(eq(verificationRuns.storyId, story.id), eq(verificationRuns.commitSha, mergedSha), eq(verificationRuns.status, 'passed')))
        .all(),
    ).toHaveLength(0);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
  });
});

describe('VerificationRunner interruption', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;
  let interrupts: RunInterruptRegistry;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-verif-stop-') });
    interrupts = new RunInterruptRegistry();
  });

  afterAll(() => {
    dbHolder.close();
  });

  const verifier = () =>
    new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-verif-stop-logs-'),
      interrupts,
    });

  const candidateFor = async (repoPath: string, storyKey: string, file: string, content: string) => {
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey, baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, file), content);
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', `feat: ${storyKey}`], { cwd: worktreePath });
    return {
      worktreePath,
      candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
      candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    };
  };

  /** A long check that marks its start in the worktree so the test knows the process is alive. */
  const LONG_CHECK =
    'node -e "require(\'node:fs\').writeFileSync(\'check-started.marker\', \'running\'); setInterval(function () {}, 1000)"';

  test('a registry stop during a long check kills it; the run ends failed and never passes', async () => {
    const repoPath = makeTempRepo({ name: 'verif-stop-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [{ key: 'long', command: LONG_CHECK, mandatory: true, timeoutSec: 30 }] },
    });
    const candidate = await candidateFor(repoPath, 'VRF-9', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-9',
      title: 'Stop mid-check',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const pending = verifier().verifyStory(story.id);

    const marker = path.join(candidate.worktreePath, 'check-started.marker');
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(marker)).toBe(true);
    expect(interrupts.active(story.id)).toBeDefined(); // the stop handle is live while checks run

    await interrupts.requestStop(story.id);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, status: 'failed', passed: false });
    const runs = dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.storyId, story.id)).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, runs[0]!.id)).all();
    // 'failed' (killed) rather than 'timed_out' proves the stop seam did the work.
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ checkKey: 'long', mandatory: true, status: 'failed' })]));
    expect(
      dbHolder.db
        .select()
        .from(verificationRuns)
        .where(and(eq(verificationRuns.storyId, story.id), eq(verificationRuns.status, 'passed')))
        .all(),
    ).toHaveLength(0);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
    expect(interrupts.active(story.id)).toBeUndefined();
    expect(interrupts.activeStoryIds()).not.toContain(story.id);
  }, 25_000);

  test('unregisters the handle after a passing verification', async () => {
    const repoPath = makeTempRepo({ name: 'verif-stop-pass-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      settings: { ...defaultProjectSettings(), checks: [{ key: 'ok', command: 'git status', mandatory: true, timeoutSec: 10 }] },
    });
    const candidate = await candidateFor(repoPath, 'VRF-10', 'a.txt', 'a\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'VRF-10',
      title: 'Clean pass',
      status: 'TESTING',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });

    const result = await verifier().verifyStory(story.id);

    expect(result).toMatchObject({ ok: true, status: 'passed', passed: true });
    expect(interrupts.active(story.id)).toBeUndefined();
    expect(interrupts.activeStoryIds()).not.toContain(story.id);
  }, 20_000);
});
