import { acceptanceCriteria, plans, userStories } from '@aik/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PlannerAgent } from '../src/agents/planner.ts';
import type { OpenCodeRuntime } from '../src/agents/runtime.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

describe('PlannerAgent', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('generates plan, saves to plans table, and transitions story to READY on auto-accept', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Add User Logout Button',
      description: 'Add a logout button in the header.',
      status: 'NEW',
    });

    dbHolder.db.insert(acceptanceCriteria).values({
      storyId: story.id,
      storyRevision: 1,
      ordinal: 1,
      text: 'Clicking logout clears session and redirects to /login',
      source: 'human',
      createdAt: new Date(),
    }).run();

    const mockResponseJson = JSON.stringify({
      schemaVersion: 1,
      summary: 'Add logout button and session clearing logic',
      assumptions: ['Auth token is stored in localStorage'],
      clarificationQuestions: [],
      acceptanceCriteria: [
        { ref: 'AC-1', text: 'Clicking logout clears session', testable: true, verification: 'Unit test' },
      ],
      subtasks: [
        { id: '1', description: 'Create LogoutButton component', files: ['apps/ui/src/components/LogoutButton.tsx'] },
        { id: '2', description: 'Add onClick handler calling logout API', files: ['apps/ui/src/lib/auth.ts'] },
      ],
      affectedFiles: ['apps/ui/src/components/LogoutButton.tsx', 'apps/ui/src/lib/auth.ts'],
      requiredTests: ['apps/ui/test/logout.test.ts'],
      migrations: { required: false, notes: '' },
      securitySensitive: [],
      dependencyChanges: [],
      conflictsWith: [],
      complexity: 'S',
      risks: [],
    });

    const mockRuntime: OpenCodeRuntime = {
      runOneShot: vi.fn().mockResolvedValue({
        ok: true,
        text: `Here is the plan:\n\`\`\`json\n${mockResponseJson}\n\`\`\``,
      }),
    } as unknown as OpenCodeRuntime;

    const planner = new PlannerAgent({
      db: dbHolder.db,
      workflow,
      bus,
      runtime: mockRuntime,
    });

    const result = await planner.planStory({
      storyId: story.id,
      autoAccept: true,
    });

    expect(result.ok).toBe(true);
    expect(result.planId).toBeDefined();

    // Verify database row
    const savedPlan = dbHolder.db.select().from(plans).where(eq(plans.storyId, story.id)).get();
    expect(savedPlan).toBeDefined();
    expect(savedPlan?.status).toBe('approved');
    expect(savedPlan?.content.summary).toContain('Add logout button');

    // Verify story transitioned to READY
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('READY');
    expect(updatedStory?.planningStatus).toBe('plan_approved');
  });
});
