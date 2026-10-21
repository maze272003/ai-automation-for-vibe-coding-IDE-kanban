import { defaultProjectSettings } from '@aik/contracts';
import { mergeApprovals, merges, userStories, verificationChecks, verificationRuns } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { LocalMerger } from '../src/git/merger.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { VerificationRunner } from '../src/verify/runner.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedPlan, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('LocalMerger', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-merge-wt-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  const makeCandidate = async (repoPath: string, storyKey: string, file: string, content: string) => {
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

  const approve = (storyId: number, sha: string) => {
    dbHolder.db
      .insert(mergeApprovals)
      .values({ storyId, kind: 'merge', commitSha: sha, approver: 'local-user', approvedAt: new Date() })
      .run();
  };

  const buildMerger = () => {
    const verification = new VerificationRunner({
      db: dbHolder.db,
      workflow,
      bus,
      worktreeManager,
      logsDir: makeTempDir('aikanban-merge-logs-'),
    });
    return new LocalMerger({ db: dbHolder.db, workflow, bus, worktreeManager, verification });
  };

  test('merges an approved candidate into base, runs post-merge checks, and moves the story to DONE', async () => {
    const repoPath = makeTempRepo({ name: 'merge-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [{ key: 'test-check', command: 'git status', mandatory: true, timeoutSec: 10 }],
      },
    });

    const candidate = await makeCandidate(repoPath, 'MRG-1', 'feature-done.txt', 'feature complete\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-1',
      title: 'Merge Story',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id, approver: 'local-user' });

    expect(result.ok).toBe(true);
    expect(result.mergedSha).toBeDefined();
    expect(execFileSync('git', ['merge-base', '--is-ancestor', candidate.candidateSha, result.mergedSha!], { cwd: repoPath })).toBeDefined();

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('DONE');
    expect(updated?.mergedSha).toBe(result.mergedSha);

    const m = dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).get();
    expect(m?.status).toBe('succeeded');
    expect(m?.mergedSha).toBe(result.mergedSha);

    const post = dbHolder.db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.commitSha, result.mergedSha!))
      .get();
    expect(post).toMatchObject({ trigger: 'postmerge', status: 'passed' });
    const checks = dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.verificationRunId, post!.id)).all();
    expect(checks.map((c) => c.checkKey)).toContain('test-check');

    expect(fs.readFileSync(path.join(repoPath, 'feature-done.txt'), 'utf8').trim()).toBe('feature complete');
  });

  test('refuses to merge without a human approval for the exact candidate', async () => {
    const repoPath = makeTempRepo({ name: 'merge-no-approval-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-2', 'two.txt', 'two\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-2',
      title: 'No approval',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no human merge approval/i);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
    expect(fs.existsSync(path.join(repoPath, 'two.txt'))).toBe(false);
  });

  test('refuses to merge into a dirty checked-out base and leaves the story awaiting merge', async () => {
    const repoPath = makeTempRepo({ name: 'merge-dirty-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-3', 'three.txt', 'three\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-3',
      title: 'Dirty checkout',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# dirty\n');

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/commit or stash/i);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
  });

  test('blocks with post_merge_failed instead of DONE when a mandatory post-merge check fails', async () => {
    const repoPath = makeTempRepo({ name: 'merge-fail-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [{ key: 'broken', command: 'git log non_existent_ref_98765', mandatory: true, timeoutSec: 10 }],
      },
    });
    const candidate = await makeCandidate(repoPath, 'MRG-4', 'four.txt', 'four\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-4',
      title: 'Post-merge failure',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/post-merge checks failed/i);
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('post_merge_failed');
    expect(updated?.mergedSha).toBeNull();
  });

  test('syncs a moved base into the story branch and returns the story to TESTING (T11)', async () => {
    const repoPath = makeTempRepo({ name: 'merge-sync-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-5', 'five.txt', 'five\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-5',
      title: 'Base sync',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    // The base moves after the approval.
    execFileSync(
      'git',
      ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '--allow-empty', '-m', 'base moved'],
      { cwd: repoPath },
    );
    const movedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.reverificationRequired).toBe(true);
    expect(result.mergedSha).toBeUndefined();

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('TESTING');
    expect(updated?.candidateSha).not.toBe(candidate.candidateSha);
    expect(updated?.candidateSha).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate.worktreePath, encoding: 'utf8' }).trim(),
    );

    // The base branch itself is untouched by the sync and no merge evidence exists.
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe(movedBase);
    expect(dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all()).toHaveLength(0);
  });

  test('moves a candidate that conflicts with the moved base to REWORK (T12)', async () => {
    const repoPath = makeTempRepo({ name: 'merge-conflict-rework-repo' });
    fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'seed conflict file'], { cwd: repoPath });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-6', 'conflict.txt', 'candidate\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-6',
      title: 'Conflict rework',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    // The base moves the same file, so the three-way merge cannot succeed.
    fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'moved\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'base moved'], { cwd: repoPath });
    const movedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/conflict/i);
    expect(result.error).toContain('conflict.txt');
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('REWORK');
    expect(updated?.status).not.toBe('AWAITING_MERGE');

    // The base branch, the story worktree, and the merge evidence are all untouched.
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe(movedBase);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate.worktreePath, encoding: 'utf8' }).trim()).toBe(candidate.candidateSha);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: candidate.worktreePath, encoding: 'utf8' }).trim()).toBe('');
    expect(dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all()).toHaveLength(0);
  });

  test('blocks a conflicting candidate with reason conflict when attempts are exhausted', async () => {
    const repoPath = makeTempRepo({ name: 'merge-conflict-blocked-repo' });
    fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'seed conflict file'], { cwd: repoPath });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-7', 'conflict.txt', 'candidate\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-7',
      title: 'Conflict blocked',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
      attemptCount: 3,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'moved\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'base moved'], { cwd: repoPath });

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/conflict/i);
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('conflict');
    expect(dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all()).toHaveLength(0);
  });

  test('stops without side effects when the merge job lease was lost', async () => {
    const repoPath = makeTempRepo({ name: 'merge-lease-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await makeCandidate(repoPath, 'MRG-8', 'eight.txt', 'eight\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-8',
      title: 'Lease lost',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);
    const baseBefore = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id, assertLease: () => false });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lease was lost/i);
    expect(result.error).toMatch(/before creating the merged commit/i);

    // No transition, no merge row, no base movement.
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('AWAITING_MERGE');
    expect(dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all()).toHaveLength(0);
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe(baseBefore);
    expect(fs.existsSync(path.join(repoPath, 'eight.txt'))).toBe(false);
  });

  test('blocks with post_merge_failed when a post-merge check mutates HEAD during the run', async () => {
    const repoPath = makeTempRepo({ name: 'merge-mutate-repo' });
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
    const candidate = await makeCandidate(repoPath, 'MRG-9', 'nine.txt', 'nine\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-9',
      title: 'Mutating check',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HEAD changed/i);
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.status).not.toBe('DONE');
    expect(updated?.blockedReason).toBe('post_merge_failed');
    expect(updated?.mergedSha).toBeNull();

    // The git fact stands: the merge itself succeeded, and the evidence run was invalidated.
    const m = dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).get();
    expect(m?.status).toBe('succeeded');
    expect(m?.mergedSha).toBeDefined();
    const post = dbHolder.db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.commitSha, m!.mergedSha!))
      .get();
    expect(post).toMatchObject({ trigger: 'postmerge', status: 'error' });
  });

  test('keeps a dirty story worktree after DONE and reports it as a warning, not a failure', async () => {
    const repoPath = makeTempRepo({ name: 'merge-dirty-cleanup-repo' });
    const project = seedProject(dbHolder.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [{ key: 'test-check', command: 'git status', mandatory: true, timeoutSec: 10 }],
      },
    });
    const candidate = await makeCandidate(repoPath, 'MRG-10', 'ten.txt', 'ten\n');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'MRG-10',
      title: 'Dirty cleanup',
      status: 'AWAITING_MERGE',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    approve(story.id, candidate.candidateSha);

    // An untracked file appears in the story worktree after the candidate commit.
    fs.writeFileSync(path.join(candidate.worktreePath, 'scratch-notes.txt'), 'do not delete\n');

    const result = await buildMerger().approveAndMergeStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.mergedSha).toBeDefined();
    expect(result.warning).toMatch(/story worktree kept: dirty/i);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('DONE');

    // The worktree and its unsaved work survive; the merge itself landed.
    expect(fs.existsSync(candidate.worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(candidate.worktreePath, 'scratch-notes.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, 'ten.txt'), 'utf8').trim()).toBe('ten');
  });

  describe('revertFailedMerge', () => {
    test('reverts a failed merge commit on the base branch and restores the base tree', async () => {
      const repoPath = makeTempRepo({ name: 'merge-revert-repo' });
      const baseBeforeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
      const baseBeforeTree = execFileSync('git', ['log', '-1', '--format=%T', baseBeforeSha], { cwd: repoPath, encoding: 'utf8' }).trim();

      const project = seedProject(dbHolder.db, {
        repoPath,
        baseBranch: 'main',
        settings: {
          ...defaultProjectSettings(),
          checks: [{ key: 'fail-check', command: 'node -e "process.exit(1)"', mandatory: true, timeoutSec: 10 }],
        },
      });
      const candidate = await makeCandidate(repoPath, 'MRG-11', 'bad-feature.txt', 'bad feature content\n');
      const story = seedStory(dbHolder.db, project.id, {
        key: 'MRG-11',
        title: 'Bad Feature Story',
        status: 'AWAITING_MERGE',
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTree,
      });
      seedPlan(dbHolder.db, story.id, { status: 'approved' });
      approve(story.id, candidate.candidateSha);

      const merger = buildMerger();
      const mergeResult = await merger.approveAndMergeStory({ storyId: story.id });
      expect(mergeResult.ok).toBe(false);

      const blockedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
      expect(blockedStory?.status).toBe('BLOCKED');
      expect(blockedStory?.blockedReason).toBe('post_merge_failed');

      // Now revert the failed merge
      const revertResult = await merger.revertFailedMerge({ storyId: story.id });
      expect(revertResult.ok).toBe(true);
      expect(revertResult.revertSha).toBeDefined();

      // Check base branch in repo
      const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
      expect(currentHead).toBe(revertResult.revertSha);

      // Check revert tree matches the base tree before merge
      const currentTree = execFileSync('git', ['log', '-1', '--format=%T', currentHead], { cwd: repoPath, encoding: 'utf8' }).trim();
      expect(currentTree).toBe(baseBeforeTree);

      // Verify commit message
      const logMsg = execFileSync('git', ['log', '-1', '--format=%B', currentHead], { cwd: repoPath, encoding: 'utf8' });
      expect(logMsg).toContain('Revert "Merge MRG-11: Bad Feature Story"');

      // Verify story detail was updated
      const storyAfterRevert = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
      expect(storyAfterRevert?.blockedDetail).toContain(revertResult.revertSha);
    });

    test('refuses to revert when story is not BLOCKED(post_merge_failed)', async () => {
      const repoPath = makeTempRepo({ name: 'merge-revert-guard-repo' });
      const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
      const story = seedStory(dbHolder.db, project.id, {
        key: 'MRG-12',
        title: 'Not Blocked Story',
        status: 'AWAITING_MERGE',
      });

      const merger = buildMerger();
      const result = await merger.revertFailedMerge({ storyId: story.id });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/post_merge_failed/i);
    });

    test('refuses to revert when base checkout is dirty', async () => {
      const repoPath = makeTempRepo({ name: 'merge-revert-dirty-repo' });
      const project = seedProject(dbHolder.db, {
        repoPath,
        baseBranch: 'main',
        settings: {
          ...defaultProjectSettings(),
          checks: [{ key: 'fail-check', command: 'node -e "process.exit(1)"', mandatory: true, timeoutSec: 10 }],
        },
      });
      const candidate = await makeCandidate(repoPath, 'MRG-13', 'fail.txt', 'fail\n');
      const story = seedStory(dbHolder.db, project.id, {
        key: 'MRG-13',
        title: 'Dirty base revert',
        status: 'AWAITING_MERGE',
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTree,
      });
      seedPlan(dbHolder.db, story.id, { status: 'approved' });
      approve(story.id, candidate.candidateSha);

      const merger = buildMerger();
      await merger.approveAndMergeStory({ storyId: story.id });

      // Dirty the main worktree
      fs.writeFileSync(path.join(repoPath, 'dirty-file.txt'), 'dirty content\n');

      const result = await merger.revertFailedMerge({ storyId: story.id });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Commit or stash your changes/i);
    });
  });
});

