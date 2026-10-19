import { userStories } from '@aik/db';
import { eq } from 'drizzle-orm';
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
});
