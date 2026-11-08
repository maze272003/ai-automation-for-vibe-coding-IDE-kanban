import { expect, it } from 'vitest';
import { agentRuns, modelUsage, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import { finishRun } from '../src/agents/finish-run.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { readOutbox } from './helpers/outbox.ts';

let runCounter = 0;

function seedRun(db: AikDb, storyId: number) {
  runCounter += 1;
  return db
    .insert(agentRuns)
    .values({
      storyId, role: 'implementer', attempt: 1, promptVersion: '1.0',
      opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `finish_${runCounter}`,
      startedAt: new Date(1_000),
    })
    .returning()
    .get();
}

const USAGE = { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 3, assistantMessages: 2, reportedCostUsd: 0.02 };

it('finishes a succeeded run with one priced usage row and ordered outbox events', () => {
  const t = createTestDb();
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const run = seedRun(t.db, story.id);

  finishRun(t.db, new Date(5_000), {
    runId: run.id, status: 'succeeded', exitReason: null,
    usage: USAGE, model: { id: 'sonnet-4', providerID: 'anthropic' }, durationMs: 4_000,
  });

  expect(t.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()).toMatchObject({
    status: 'succeeded', endedAt: new Date(5_000), exitReason: null,
    usage: { requests: 2, inTok: 10, outTok: 5, cachedInTok: 3, costUsd: 0.02, costSource: 'reported' },
  });

  const usageRows = t.db.select().from(modelUsage).all();
  expect(usageRows).toHaveLength(1);
  expect(usageRows[0]).toMatchObject({ agentRunId: run.id, storyId: story.id, projectId: project.id });

  const events = readOutbox(t.db);
  expect(events.map((e) => e.topic)).toEqual(['usage.recorded', 'run.finished']);
  expect(events[1]?.data).toMatchObject({ runId: run.id, status: 'succeeded' });
  t.close();
});

it('a second finishRun call for the same run is a no-op', () => {
  const t = createTestDb();
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const run = seedRun(t.db, story.id);
  const input = {
    runId: run.id, status: 'succeeded' as const, exitReason: null,
    usage: USAGE, model: { id: 'sonnet-4', providerID: 'anthropic' }, durationMs: 4_000,
  };

  finishRun(t.db, new Date(5_000), input);
  finishRun(t.db, new Date(6_000), { ...input, status: 'failed' });

  expect(t.db.select().from(modelUsage).all()).toHaveLength(1);
  expect(t.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()).toMatchObject({ status: 'succeeded', endedAt: new Date(5_000) });
  expect(readOutbox(t.db).map((e) => e.topic)).toEqual(['usage.recorded', 'run.finished']);
  t.close();
});

it('records an unknown-cost row when usage is null', () => {
  const t = createTestDb();
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const run = seedRun(t.db, story.id);

  finishRun(t.db, new Date(5_000), {
    runId: run.id, status: 'interrupted', exitReason: 'stop requested',
    usage: null, model: null, durationMs: null,
  });

  expect(t.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()).toMatchObject({ status: 'interrupted', endedAt: new Date(5_000) });
  expect(t.db.select().from(modelUsage).get()).toMatchObject({
    agentRunId: run.id, storyId: story.id, projectId: project.id,
    inputTokens: null, outputTokens: null, costUsd: null, costSource: 'unknown',
  });
  t.close();
});
