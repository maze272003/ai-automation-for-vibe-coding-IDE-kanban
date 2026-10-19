import { reviewFindings, reviews, storyEvents, userStories, verificationChecks, verificationRuns } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ImplementerAgent } from '../src/agents/implementer.ts';
import type { OpenCodeRuntime } from '../src/agents/runtime.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedPlan, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('Rework Loop', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-rework-wt-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('claims story in REWORK, supplies review findings to model prompt, commits, and returns to TESTING', async () => {
    const repoPath = makeTempRepo({ name: 'rework-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });

    const { worktreePath } = await worktreeManager.ensureStoryWorktree({
      repoPath,
      storyKey: 'REW-1',
      baseBranch: 'main',
    });

    // Initial commit
    fs.writeFileSync(path.join(worktreePath, 'feature.ts'), 'export const val = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'attempt 1'], { cwd: worktreePath });
    const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const initialTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REW-1',
      title: 'Rework Story',
      status: 'REWORK',
      candidateSha: initialSha,
      candidateTree: initialTree,
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    // Seed prior review finding
    const rev = dbHolder.db
      .insert(reviews)
      .values({
        storyId: story.id,
        commitSha: initialSha,
        actor: 'agent',
        rawVerdict: 'CHANGES_REQUESTED',
        verdict: 'CHANGES_REQUESTED',
        summary: 'Fix required',
        raw: { schemaVersion: 1, verdict: 'CHANGES_REQUESTED', summary: 'Fix required', acChecklist: [], findings: [], priorFindings: [] },
        createdAt: new Date(),
      })
      .returning()
      .get();
    dbHolder.db
      .insert(reviewFindings)
      .values({
        reviewId: rev.id,
        findingKey: 'F-1',
        severity: 'high',
        category: 'correctness',
        evidence: 'val is 1',
        explanation: 'val should be 2',
        recommendation: 'change val to 2',
        blocking: true,
      })
      .run();

    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string; prompt: string }) => {
        capturedPrompt = opts.prompt;
        fs.writeFileSync(path.join(opts.directory, 'feature.ts'), 'export const val = 2;\n');
        return { ok: true, text: 'Fixed val to 2.' };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
    });

    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain('val should be 2');

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('TESTING');
    expect(updated?.attemptCount).toBe(2);
    expect(updated?.candidateSha).not.toBe(initialSha);
  });

  test('feeds failing check tails from the current candidate into the repair prompt', async () => {
    const repoPath = makeTempRepo({ name: 'rework-checks-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'REW-2', baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, 'value.ts'), 'export const val = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'attempt 1'], { cwd: worktreePath });
    const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const initialTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REW-2',
      title: 'Check repair',
      status: 'REWORK',
      candidateSha: initialSha,
      candidateTree: initialTree,
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    const run = dbHolder.db
      .insert(verificationRuns)
      .values({ storyId: story.id, commitSha: initialSha, trigger: 'candidate', status: 'failed', startedAt: new Date(), endedAt: new Date() })
      .returning()
      .get();
    dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: run.id,
        checkKey: 'unit',
        mandatory: true,
        command: 'npm test',
        cwd: worktreePath,
        status: 'failed',
        exitCode: 1,
        outputTail: 'Expected val to be 2 but received 1',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    let capturedPrompt = '';
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string; prompt: string }) => {
        capturedPrompt = opts.prompt;
        fs.writeFileSync(path.join(opts.directory, 'value.ts'), 'export const val = 2;\n');
        return { ok: true, text: 'Fixed' };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain('FAILING CHECKS (current candidate)');
    expect(capturedPrompt).toContain('Expected val to be 2 but received 1');
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
  });

  test('blocks with no_progress when the repair produces a previously rejected tree', async () => {
    const repoPath = makeTempRepo({ name: 'rework-noprogress-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'REW-3', baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, 'value.ts'), 'export const val = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'attempt 1'], { cwd: worktreePath });
    const initialSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const initialTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    // Predict the tree the next attempt will produce, then restore the clean worktree.
    fs.writeFileSync(path.join(worktreePath, 'value.ts'), 'export const val = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    const rejectedTree = execFileSync('git', ['write-tree'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: worktreePath });

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REW-3',
      title: 'No progress',
      status: 'REWORK',
      candidateSha: initialSha,
      candidateTree: initialTree,
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });
    dbHolder.db
      .insert(storyEvents)
      .values({
        storyId: story.id,
        type: 'transition',
        fromStatus: 'IN_PROGRESS',
        toStatus: 'TESTING',
        actor: 'system',
        payload: {
          transition: 'T4',
          event: { type: 'candidate_committed', runId: 999, candidateSha: initialSha, candidateTree: rejectedTree, diffEmpty: false, treeAlreadyRejected: false },
          effects: [],
        },
        createdAt: new Date(),
      })
      .run();

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string }) => {
        fs.writeFileSync(path.join(opts.directory, 'value.ts'), 'export const val = 2;\n');
        return { ok: true, text: 'Done' };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.candidateSha).toBeDefined();
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('no_progress');
  });

  test('blocks with retry_limit when the attempt budget is already exhausted', async () => {
    const repoPath = makeTempRepo({ name: 'rework-limit-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'REW-4', baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, 'value.ts'), 'export const val = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'attempt 1'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REW-4',
      title: 'Exhausted',
      status: 'REWORK',
      candidateSha,
      candidateTree,
      attemptCount: 3,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const mockRuntime: OpenCodeRuntime = { runOneShot: vi.fn() } as unknown as OpenCodeRuntime;
    const agent = new ImplementerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(mockRuntime.runOneShot).not.toHaveBeenCalled();
    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('retry_limit');
  });

  test('records protected paths on the candidate event', async () => {
    const repoPath = makeTempRepo({ name: 'rework-protected-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'REW-5', baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, 'value.ts'), 'export const val = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'attempt 1'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();

    const story = seedStory(dbHolder.db, project.id, {
      key: 'REW-5',
      title: 'Protected',
      status: 'REWORK',
      candidateSha,
      candidateTree,
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string }) => {
        fs.mkdirSync(path.join(opts.directory, '.github', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(opts.directory, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
        fs.writeFileSync(path.join(opts.directory, 'value.ts'), 'export const val = 2;\n');
        return { ok: true, text: 'Done' };
      }),
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    const events = dbHolder.db.select().from(storyEvents).where(eq(storyEvents.storyId, story.id)).all();
    const committed = events.find((e) => (e.payload?.event as { type?: string } | undefined)?.type === 'candidate_committed');
    const payload = committed?.payload as { event?: { protectedPaths?: string[] } } | null | undefined;
    expect(payload?.event?.protectedPaths).toEqual(['.github/workflows/ci.yml']);
  });
});
