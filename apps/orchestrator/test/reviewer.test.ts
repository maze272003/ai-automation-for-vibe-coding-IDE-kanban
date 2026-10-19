import { agentRuns, reviewAcResults, reviewFindings, reviews, userStories, verificationChecks, verificationRuns } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ReviewerAgent, isVerifiedLocation, normalizeReview, parseReviewOutput } from '../src/agents/reviewer.ts';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';
import type { OpenCodeRuntime, RunOneShotInput } from '../src/agents/runtime.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedPlan, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('ReviewerAgent', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-rev-wt-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('approves candidate and transitions story from READY_FOR_REVIEW to AWAITING_MERGE', async () => {
    const repoPath = makeTempRepo({ name: 'rev-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'REV-1',
      baseBranch: 'main',
    });

    fs.writeFileSync(path.join(worktreePath, 'solution.ts'), 'export const solve = () => 42;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: solve'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-1',
      title: 'Review Story 1',
      status: 'READY_FOR_REVIEW',
      candidateSha,
      candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Returns 42');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const { verificationRuns, verificationChecks } = await import('@aik/db');
    const vRun = dbHolder.db
      .insert(verificationRuns)
      .values({
        storyId: story.id,
        commitSha: candidateSha,
        trigger: 'candidate',
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: vRun.id,
        checkKey: 'test',
        mandatory: true,
        command: 'git status',
        cwd: worktreePath,
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({
        ok: true,
        text: JSON.stringify({
          schemaVersion: 1,
          verdict: 'APPROVED',
          summary: 'Looks great! Clean implementation.',
          acChecklist: [
            { acRef: String(ac.id), status: 'met', evidence: 'Verified solution returns 42' },
          ],
          findings: [],
          priorFindings: [],
        }),
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
    });

    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('AWAITING_MERGE');

    const rev = dbHolder.db.select().from(reviews).where(eq(reviews.storyId, story.id)).get();
    expect(rev?.verdict).toBe('APPROVED');
  });

  test('normalizes APPROVED to CHANGES_REQUESTED when a blocking finding exists', async () => {
    const repoPath = makeTempRepo({ name: 'rev-norm-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'REV-2',
      baseBranch: 'main',
    });

    fs.writeFileSync(path.join(worktreePath, 'bug.ts'), 'export const bug = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: bug'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-2',
      title: 'Review Story 2',
      status: 'READY_FOR_REVIEW',
      candidateSha,
      candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Criteria');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({
        ok: true,
        text: JSON.stringify({
          schemaVersion: 1,
          verdict: 'APPROVED',
          summary: 'Looks mostly good but has a blocker.',
          acChecklist: [
            { acRef: String(ac.id), status: 'met', evidence: 'Criteria met' },
          ],
          findings: [
            {
              id: 'FIND-1',
              severity: 'critical',
              category: 'correctness',
              file: 'ghost/missing.ts',
              evidence: 'bug found',
              explanation: 'Major bug found in logic',
              recommendation: 'Fix logic',
              blocking: true,
            },
            {
              id: 'FIND-2',
              severity: 'low',
              category: 'tests',
              file: 'bug.ts',
              evidence: 'no test covers this',
              explanation: 'The changed file lacks coverage',
              recommendation: 'Add a test',
              blocking: false,
            },
          ],
          priorFindings: [],
        }),
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
    });

    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('CHANGES_REQUESTED');

    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('REWORK');

    const rev = dbHolder.db.select().from(reviews).where(eq(reviews.storyId, story.id)).get();
    expect(rev?.rawVerdict).toBe('APPROVED');
    expect(rev?.verdict).toBe('CHANGES_REQUESTED');
    expect(rev?.normalizationNote).toContain('blocking findings');

    const persistedFindings = dbHolder.db.select().from(reviewFindings).where(eq(reviewFindings.reviewId, rev!.id)).all();
    expect(persistedFindings.find((f) => f.findingKey === 'FIND-1')).toMatchObject({
      severity: 'critical',
      blocking: true,
      filePath: 'ghost/missing.ts',
      locationVerified: false,
    });
    expect(persistedFindings.find((f) => f.findingKey === 'FIND-2')).toMatchObject({
      filePath: 'bug.ts',
      locationVerified: true,
    });
    const persistedAc = dbHolder.db.select().from(reviewAcResults).where(eq(reviewAcResults.reviewId, rev!.id)).get();
    expect(persistedAc).toMatchObject({ acceptanceCriterionId: ac.id, status: 'met' });
  });

  const reviewCandidate = async (repoPath: string, storyKey: string, file: string) => {
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey, baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, file), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', `feat: ${storyKey}`], { cwd: worktreePath });
    return {
      candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
      candidateTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    };
  };

  const approvedReview = (acRef: string) =>
    JSON.stringify({
      schemaVersion: 1,
      verdict: 'APPROVED',
      summary: 'Fine.',
      acChecklist: [{ acRef, status: 'met', evidence: 'ok' }],
      findings: [],
      priorFindings: [],
    });

  test('discards a dirty review worktree and retries once with a fresh worktree', async () => {
    const repoPath = makeTempRepo({ name: 'rev-dirty-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await reviewCandidate(repoPath, 'REV-3', 'dirty-review.ts');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-3',
      title: 'Dirty reviewer',
      status: 'READY_FOR_REVIEW',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Works');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    const verification = dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: candidate.candidateSha, trigger: 'candidate', status: 'passed', startedAt: new Date(), endedAt: new Date() })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: verification.id,
        checkKey: 'test',
        mandatory: true,
        command: 'git status',
        cwd: candidate.candidateSha,
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    let call = 0;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string }) => {
        call += 1;
        if (call === 1) fs.writeFileSync(path.join(opts.directory, 'reviewer-dirty.txt'), 'dirty\n');
        return { ok: true, text: approvedReview(String(ac.id)) };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.reviewStory({ storyId: story.id });
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    expect(mockRuntime.runOneShot).toHaveBeenCalledTimes(2);
    const runs = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).all();
    expect(runs.map((r) => r.status).sort()).toEqual(['failed', 'succeeded']);
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
  });

  test('blocks with invalid_agent_output after two invalid reviewer outputs', async () => {
    const repoPath = makeTempRepo({ name: 'rev-invalid-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await reviewCandidate(repoPath, 'REV-4', 'invalid-review.ts');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-4',
      title: 'Invalid reviewer',
      status: 'READY_FOR_REVIEW',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    seedAcceptanceCriterion(dbHolder.db, story.id, 'Works');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({ ok: true, text: 'not json at all' }),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(mockRuntime.runOneShot).toHaveBeenCalledTimes(2);
    expect(dbHolder.db.select().from(reviews).where(eq(reviews.storyId, story.id)).all()).toHaveLength(0);
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('invalid_agent_output');
  });

  test('registers the session with the interrupt registry and unregisters after an approved review', async () => {
    const repoPath = makeTempRepo({ name: 'rev-registry-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await reviewCandidate(repoPath, 'REV-5', 'registry-review.ts');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-5',
      title: 'Registry review',
      status: 'READY_FOR_REVIEW',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Works');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    const verification = dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: candidate.candidateSha, trigger: 'candidate', status: 'passed', startedAt: new Date(), endedAt: new Date() })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: verification.id,
        checkKey: 'test',
        mandatory: true,
        command: 'git status',
        cwd: repoPath,
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);
    let runIdDuringSession: number | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        expect(opts.shouldStop?.()).toBe(false);
        await opts.onSessionCreated?.('ses_rev_registry');
        runIdDuringSession = registry.active(story.id)?.runId;
        return { ok: true, text: approvedReview(String(ac.id)) };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager, interrupts: registry });
    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('succeeded');
    expect(runIdDuringSession).toBe(run?.id);
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
  });

  test('records an interrupted review run without retrying, consuming an attempt, or transitioning', async () => {
    const repoPath = makeTempRepo({ name: 'rev-stopped-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await reviewCandidate(repoPath, 'REV-6', 'stopped-review.ts');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-6',
      title: 'Stopped review',
      status: 'READY_FOR_REVIEW',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
      attemptCount: 2,
      maxAttempts: 3,
    });
    seedAcceptanceCriterion(dbHolder.db, story.id, 'Works');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);
    const transitionSpy = vi.spyOn(workflow, 'transition');
    let sessionDirectory: string | undefined;

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        sessionDirectory = opts.directory;
        await opts.onSessionCreated?.('ses_rev_stopped');
        await registry.requestStop(story.id);
        // Production ordering (EXE-13): the stop request transitions the story before the interrupt lands.
        forceStory(dbHolder.db, story.id, { status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null });
        return { ok: false, interrupted: true, error: 'Aborted' };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager, interrupts: registry });
    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(mockRuntime.runOneShot).toHaveBeenCalledTimes(1); // no second attempt after a stop

    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('interrupted');
    expect(run?.exitReason).toContain('stop request');

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('interrupted');
    expect(updated?.attemptCount).toBe(2);
    expect(dbHolder.db.select().from(reviews).where(eq(reviews.storyId, story.id)).all()).toHaveLength(0);

    expect(transitionSpy).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith('ses_rev_stopped', sessionDirectory);
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    transitionSpy.mockRestore();
  });

  test('behaves identically without the interrupts dependency', async () => {
    const repoPath = makeTempRepo({ name: 'rev-nodep-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const candidate = await reviewCandidate(repoPath, 'REV-7', 'nodep-review.ts');
    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-7',
      title: 'No registry review',
      status: 'READY_FOR_REVIEW',
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Works');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    const verification = dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: candidate.candidateSha, trigger: 'candidate', status: 'passed', startedAt: new Date(), endedAt: new Date() })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: verification.id,
        checkKey: 'test',
        mandatory: true,
        command: 'git status',
        cwd: repoPath,
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    let shouldStopResult: boolean | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        shouldStopResult = opts.shouldStop?.();
        await opts.onSessionCreated?.('ses_rev_nodep');
        return { ok: true, text: approvedReview(String(ac.id)) };
      }),
      interrupt: vi.fn().mockResolvedValue(true),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.reviewStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    expect(shouldStopResult).toBe(false);
    expect(mockRuntime.interrupt).not.toHaveBeenCalled();
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('AWAITING_MERGE');
  });

  test('parses only a valid ReviewV1 block and rejects BLOCKED without a reason', () => {
    const valid = approvedReview('AC-1');
    expect(parseReviewOutput(`Here you go:\n\`\`\`json\n${valid}\n\`\`\``)).toMatchObject({ ok: true, value: { verdict: 'APPROVED' } });
    expect(parseReviewOutput('not json')).toMatchObject({ ok: false });
    expect(
      parseReviewOutput(
        JSON.stringify({ schemaVersion: 1, verdict: 'BLOCKED', summary: 'x', acChecklist: [], findings: [], priorFindings: [] }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/requires blockedReason/) });
  });

  test('marks findings that cite files outside the diff and repo as unverified locations', () => {
    const diffFiles = new Set(['src/a.ts', 'src/b.ts']);
    const repoFiles = new Set(['src/c.ts']);
    const repoHasFile = (f: string) => repoFiles.has(f);
    expect(isVerifiedLocation('src/a.ts', diffFiles, repoHasFile)).toBe(true); // in the diff
    expect(isVerifiedLocation('src\\c.ts', diffFiles, repoHasFile)).toBe(true); // in the repo
    expect(isVerifiedLocation('src/missing.ts', diffFiles, repoHasFile)).toBe(false);
    expect(isVerifiedLocation(undefined, diffFiles, repoHasFile)).toBe(true); // nothing cited
    expect(isVerifiedLocation('C:/Windows/system32/config', diffFiles, repoHasFile)).toBe(false);
    expect(isVerifiedLocation('../outside.ts', diffFiles, repoHasFile)).toBe(false);
  });

  test('normalizes missing and unmet criteria to CHANGES_REQUESTED', () => {
    const raw = {
      schemaVersion: 1 as const,
      verdict: 'APPROVED' as const,
      summary: 'ok',
      acChecklist: [{ acRef: 'AC-1', status: 'unmet' as const, evidence: 'no' }],
      findings: [],
      priorFindings: [],
    };
    const normalized = normalizeReview(raw, [{ id: 7, ordinal: 1 }, { id: 8, ordinal: 2 }], new Set());
    expect(normalized.verdict).toBe('CHANGES_REQUESTED');
    expect(normalized.normalizationNote).toContain('unmet or unclear criteria AC-1');
    expect(normalized.normalizationNote).toContain('missing checklist entries for AC-2');
  });

  test('injects skills for reviewer role and does not trigger dirty worktree failure', async () => {
    const repoPath = makeTempRepo({ name: 'rev-skills-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'REV-8',
      baseBranch: 'main',
    });
    fs.writeFileSync(path.join(worktreePath, 'solution.ts'), 'export const solve = () => 42;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: solve'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REV-8',
      title: 'Review Story with Skills',
      status: 'READY_FOR_REVIEW',
      candidateSha,
      candidateTree,
    });
    const ac = seedAcceptanceCriterion(dbHolder.db, story.id, 'Returns 42');
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const vRun = dbHolder.db
      .insert(verificationRuns)
      .values({
        storyId: story.id,
        commitSha: candidateSha,
        trigger: 'candidate',
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: vRun.id,
        checkKey: 'test',
        mandatory: true,
        command: 'git status',
        cwd: worktreePath,
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    const vaultRoot = makeTempDir('vault-rev-');
    const { vaultPaths, ensureVaultLayout, VaultDb } = await import('@aik/skill-vault');
    const paths = vaultPaths(vaultRoot);
    await ensureVaultLayout(paths);
    const vdb = VaultDb.open(paths.sqlite);
    vdb.db.prepare(
      `INSERT INTO skills (id, source, name, repo_owner, repo_name, skill_path, status, content_sha256, discovered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'gh:mattpocock/skills/code-review',
      'test',
      'code-review',
      'mattpocock',
      'skills',
      '.',
      'approved',
      'hash',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const skillContent = path.join(paths.skillsApproved, 'mattpocock', 'skills', 'code-review');
    fs.mkdirSync(skillContent, { recursive: true });
    fs.writeFileSync(path.join(skillContent, 'SKILL.md'), '---\nname: code-review\ndescription: Code Review\n---\n# Code Review\n');
    vdb.close();

    const { SkillBridgeService } = await import('../src/skills/bridge.ts');
    const realSkills = new SkillBridgeService({ vaultRoot });

    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        capturedPrompt = opts.prompt;
        return { ok: true, text: approvedReview(String(ac.id)) };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ReviewerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
      skills: realSkills,
    });

    const result = await agent.reviewStory({ storyId: story.id });
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    expect(capturedPrompt).toContain('AVAILABLE SKILLS');
    expect(capturedPrompt).toContain('code-review');
  });
});

