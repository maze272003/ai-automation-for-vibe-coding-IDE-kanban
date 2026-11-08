import { agentRuns, storyEvents } from '@aik/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { failedPlannerRunsSinceReset, lastPlanningReset } from '../src/agents/planning-budget.ts';
import { EventBus } from '../src/events/bus.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedProject, seedStory } from './helpers/db.ts';

// Fixed clock: a transition's story_events.createdAt is exactly NOW, and the window is strictly
// `startedAt > reset.at`, so runs seeded at NOW ± offsets sit deterministically on one side.
const NOW = 1_700_000_000_000;
const BEFORE = new Date(NOW - 60_000);
const AFTER = new Date(NOW + 60_000);

describe('planning budget', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let workflow: WorkflowService;

  beforeAll(() => {
    dbHolder = createTestDb();
    workflow = new WorkflowService({ db: dbHolder.db, bus: new EventBus(), now: () => NOW });
  });

  afterAll(() => {
    dbHolder.close();
  });

  const seedPlannerRun = (storyId: number, i: number, status: 'failed' | 'timed_out', startedAt: Date) =>
    dbHolder.db
      .insert(agentRuns)
      .values({
        storyId,
        role: 'planner',
        attempt: i,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status,
        exitReason: status === 'timed_out' ? 'The model did not finish within 600 seconds' : 'The model returned no text',
        idempotencyKey: `pb_run_${storyId}_${i}`,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 1_000),
      })
      .run();

  test('counts all failed planner runs when the story has no planning reset', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/pb-no-reset' });
    const story = seedStory(dbHolder.db, project.id, { key: 'PB-1', title: 'Never reset', status: 'NEW', planningStatus: 'planning_failed' });
    for (let i = 0; i < 3; i += 1) seedPlannerRun(story.id, i, 'failed', BEFORE);

    expect(lastPlanningReset(dbHolder.db, story.id)).toBeNull();
    expect(failedPlannerRunsSinceReset(dbHolder.db, story.id)).toBe(3);
  });

  test('a recover-to-NEW transition through WorkflowService resets the failed-run window', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/pb-recover' });
    const story = seedStory(dbHolder.db, project.id, { key: 'PB-2', title: 'Recovered', status: 'NEW', planningStatus: 'planning_failed' });
    for (let i = 0; i < 3; i += 1) seedPlannerRun(story.id, i, 'failed', BEFORE);
    // A real BLOCKED story (recover is only legal from BLOCKED); forceStory is arrange-only.
    forceStory(dbHolder.db, story.id, { status: 'BLOCKED', blockedReason: 'invalid_agent_output', blockedFrom: 'NEW', blockedDetail: 'Planning failed 3 times' });

    const outcome = workflow.transition({
      storyId: story.id,
      event: { type: 'recover', target: 'NEW', extraAttempts: 0, causeResolved: true },
      actor: 'human',
    });
    expect(outcome.ok).toBe(true);

    const event = dbHolder.db
      .select({ id: storyEvents.id, createdAt: storyEvents.createdAt })
      .from(storyEvents)
      .where(and(eq(storyEvents.storyId, story.id), eq(storyEvents.type, 'transition')))
      .orderBy(desc(storyEvents.id))
      .limit(1)
      .get();
    expect(event).toBeDefined();
    expect(lastPlanningReset(dbHolder.db, story.id)).toEqual({ eventId: event!.id, at: new Date(NOW) });

    seedPlannerRun(story.id, 3, 'failed', AFTER);
    expect(failedPlannerRunsSinceReset(dbHolder.db, story.id)).toBe(1);
  });

  test('an edit_definition transition resets the failed-run window the same way', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/pb-edit' });
    const story = seedStory(dbHolder.db, project.id, { key: 'PB-3', title: 'Edited', status: 'NEW', planningStatus: 'planning_failed' });
    seedPlannerRun(story.id, 0, 'failed', BEFORE);
    seedPlannerRun(story.id, 1, 'failed', BEFORE);

    const outcome = workflow.transition({ storyId: story.id, event: { type: 'edit_definition' }, actor: 'human' });
    expect(outcome.ok).toBe(true);
    const reset = lastPlanningReset(dbHolder.db, story.id);
    expect(reset).not.toBeNull();
    expect(reset?.at).toEqual(new Date(NOW));

    seedPlannerRun(story.id, 2, 'failed', AFTER);
    expect(failedPlannerRunsSinceReset(dbHolder.db, story.id)).toBe(1);
  });

  test('a timed_out planner run counts against the budget', () => {
    const project = seedProject(dbHolder.db, { repoPath: 'C:/repos/pb-timeout' });
    const story = seedStory(dbHolder.db, project.id, { key: 'PB-4', title: 'Slow model', status: 'NEW', planningStatus: 'planning_failed' });
    seedPlannerRun(story.id, 0, 'failed', BEFORE);
    seedPlannerRun(story.id, 1, 'timed_out', BEFORE);

    expect(failedPlannerRunsSinceReset(dbHolder.db, story.id)).toBe(2);
  });
});
