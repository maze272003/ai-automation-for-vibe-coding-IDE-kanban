import { afterAll, afterEach, expect, it } from 'vitest';
import { modelUsage } from '@aik/db';
import { recordUsage } from '../src/metrics/record-usage.ts';
import { readOutboxAfter } from '../src/events/outbox.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

const t = createTestDb();
afterAll(() => t.close());
afterEach(() => { t.db.delete(modelUsage).run(); });
const base = { agentRunId: null, storyId: null, projectId: null, runtime: 'opencode' as const, providerId: null, modelId: null, modelProfileId: null, durationMs: null };
it('writes reported usage with story/project and an outbox event', () => {
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const result = recordUsage(t.db, new Date(), { ...base, storyId: story.id, projectId: project.id,
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 3, assistantMessages: 1, reportedCostUsd: 0.02 } });
  expect(t.db.select().from(modelUsage).get()).toMatchObject({ id: result.id, storyId: story.id, projectId: project.id, costUsd: 0.02, costSource: 'reported', outputTokens: 5 });
  expect(readOutboxAfter(t.db, 0).at(-1)).toMatchObject({ topic: 'usage.recorded', data: { costUsd: 0.02 } });
});
it('records unknown usage for a probe with no run or project', () => {
  recordUsage(t.db, new Date(), { ...base, usage: null });
  expect(t.db.select().from(modelUsage).get()).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, costSource: 'unknown', agentRunId: null, storyId: null, projectId: null });
  expect(readOutboxAfter(t.db, 0).at(-1)?.storyId).toBeNull();
});
