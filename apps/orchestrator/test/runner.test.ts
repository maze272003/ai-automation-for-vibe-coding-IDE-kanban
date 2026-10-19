import { durableJobs } from '@aik/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ImplementerAgent } from '../src/agents/implementer.ts';
import type { PlannerAgent } from '../src/agents/planner.ts';
import { AgentRunner } from '../src/agents/runner.ts';
import { EventBus } from '../src/events/bus.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

describe('AgentRunner', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let queue: JobQueue;

  beforeAll(() => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    queue = new JobQueue(dbHolder.db);
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('processes plan job and delegates to PlannerAgent', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-runner' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Runner Plan Test',
      status: 'NEW',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true, planId: 1 }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true, candidateSha: 'abcdef' }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
    });

    queue.enqueue({
      kind: 'plan',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: false,
      idempotencyKey: `test_plan_${story.id}`,
    });

    await runner.tick();

    expect(mockPlanner.planStory).toHaveBeenCalledWith({ storyId: story.id });

    const jobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    const planJob = jobs.find((j) => j.kind === 'plan');
    expect(planJob?.status).toBe('succeeded');
  });

  test('processes implement job and delegates to ImplementerAgent', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-impl' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Runner Implement Test',
      status: 'READY',
      planningStatus: 'plan_approved',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true, candidateSha: '1234567890abcdef' }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
    });

    queue.enqueue({
      kind: 'implement',
      slot: 'heavy',
      storyId: story.id,
      sideEffecting: true,
      idempotencyKey: `test_impl_${story.id}`,
    });

    await runner.tick();

    expect(mockImplementer.implementStory).toHaveBeenCalledWith({ storyId: story.id });

    const jobs = dbHolder.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    const implJob = jobs.find((j) => j.kind === 'implement');
    expect(implJob?.status).toBe('succeeded');
  });

  test('auto-enqueues plan job for newly discovered un-planned story in NEW', async () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/test-proj-auto' });
    const story = seedStory(dbHolder.db, project.id, {
      title: 'Auto Enqueue Test',
      status: 'NEW',
      planningStatus: 'none',
    });

    const mockPlanner = {
      planStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlannerAgent;

    const mockImplementer = {
      implementStory: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ImplementerAgent;

    const runner = new AgentRunner({
      db: dbHolder.db,
      queue,
      workflow,
      bus,
      planner: mockPlanner,
      implementer: mockImplementer,
    });

    await runner.tick();

    expect(mockPlanner.planStory).toHaveBeenCalledWith({ storyId: story.id });
  });
});
