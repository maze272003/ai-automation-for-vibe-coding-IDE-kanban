import { agentRuns, userStories } from '@aik/db';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ImplementerAgent } from '../src/agents/implementer.ts';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';
import type { OpenCodeRuntime, RunOneShotInput } from '../src/agents/runtime.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedPlan, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('ImplementerAgent', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let worktreeManager: WorktreeManager;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-impl-wt-') });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('claims story in READY, executes OpenCode in worktree, commits, and transitions to TESTING', async () => {
    const repoPath = makeTempRepo({ name: 'impl-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Add Auth Middleware',
      status: 'READY',
      planningStatus: 'plan_approved',
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: { directory: string }) => {
        // Model creates a file in the worktree
        fs.writeFileSync(path.join(opts.directory, 'auth-middleware.ts'), 'export const auth = () => true;\n');
        return { ok: true, text: 'Implemented auth middleware.' };
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
    expect(result.candidateSha).toBeDefined();

    // Verify story transitioned to TESTING
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('TESTING');
    expect(updatedStory?.candidateSha).toBe(result.candidateSha);
    expect(updatedStory?.activeRunId).toBeNull();
  });

  test('registers the session with the interrupt registry and unregisters after a successful run', async () => {
    const repoPath = makeTempRepo({ name: 'impl-registry-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Interruptible Implement',
      status: 'READY',
      planningStatus: 'plan_approved',
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);
    let runIdDuringSession: number | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        expect(opts.shouldStop?.()).toBe(false);
        await opts.onSessionCreated?.('ses_impl_registry');
        runIdDuringSession = registry.active(story.id)?.runId;
        fs.writeFileSync(path.join(opts.directory, 'feature.ts'), 'export const x = 1;\n');
        return { ok: true, text: 'Implemented.' };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
      interrupts: registry,
    });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('succeeded');
    expect(runIdDuringSession).toBe(run?.id);
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
  });

  test('records an interrupted run without failing the attempt or transitioning the story', async () => {
    const repoPath = makeTempRepo({ name: 'impl-stopped-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Stopped Implement',
      status: 'READY',
      planningStatus: 'plan_approved',
      attemptCount: 1,
      maxAttempts: 3,
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    const registry = new RunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(true);
    const transitionSpy = vi.spyOn(workflow, 'transition');
    let sessionDirectory: string | undefined;
    let shouldStopAfter: boolean | undefined;

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        sessionDirectory = opts.directory;
        await opts.onSessionCreated?.('ses_impl_stopped');
        await registry.requestStop(story.id);
        shouldStopAfter = opts.shouldStop?.();
        // Production ordering (EXE-13): the stop request transitions the story before the interrupt lands.
        forceStory(dbHolder.db, story.id, { status: 'BLOCKED', blockedReason: 'interrupted', activeRunId: null });
        return { ok: false, interrupted: true, error: 'Aborted' };
      }),
      interrupt,
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
      worktreeManager,
      interrupts: registry,
    });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('interrupted');
    expect(shouldStopAfter).toBe(true);

    const run = dbHolder.db.select().from(agentRuns).where(eq(agentRuns.storyId, story.id)).get();
    expect(run?.status).toBe('interrupted');
    expect(run?.exitReason).toContain('stop request');

    const updated = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updated?.status).toBe('BLOCKED');
    expect(updated?.blockedReason).toBe('interrupted');
    expect(updated?.attemptCount).toBe(1);

    // Only the pre-run claim_implement transition happened; no fail transition was attempted.
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect((transitionSpy.mock.calls[0]?.[0] as { event: { type: string } }).event.type).toBe('claim_implement');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith('ses_impl_stopped', sessionDirectory);
    expect(registry.active(story.id)).toBeUndefined();
    expect(registry.isStopRequested(story.id)).toBe(false);
    transitionSpy.mockRestore();
  });

  test('behaves identically without the interrupts dependency', async () => {
    const repoPath = makeTempRepo({ name: 'impl-nodep-repo' });
    const project = seedProject(dbHolder.db, { repoPath, baseBranch: 'main' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'No Registry Implement',
      status: 'READY',
      planningStatus: 'plan_approved',
    });
    seedPlan(dbHolder.db, story.id, { status: 'approved' });

    let shouldStopResult: boolean | undefined;
    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockImplementation(async (opts: RunOneShotInput) => {
        shouldStopResult = opts.shouldStop?.();
        await opts.onSessionCreated?.('ses_impl_nodep');
        fs.writeFileSync(path.join(opts.directory, 'feature.ts'), 'export const y = 2;\n');
        return { ok: true, text: 'Done.' };
      }),
      interrupt: vi.fn().mockResolvedValue(true),
    } as unknown as OpenCodeRuntime;

    const agent = new ImplementerAgent({ db: dbHolder.db, workflow, bus, runtime: mockRuntime, worktreeManager });
    const result = await agent.implementStory({ storyId: story.id });

    expect(result.ok).toBe(true);
    expect(shouldStopResult).toBe(false);
    expect(mockRuntime.interrupt).not.toHaveBeenCalled();
    expect(dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get()?.status).toBe('TESTING');
  });
});
