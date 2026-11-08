import { agentRuns, modelUsage } from '@aik/db';
import { expect, it } from 'vitest';
import { UsageMetricsService } from '../src/metrics/usage-service.ts';
import { toStoryDTO } from '../src/stories/dto.ts';
import { buildTestApp } from './helpers/app.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir } from './helpers/temp.ts';

it('aggregates costs with direct project/story filters and no profile or run', async () => {
  const t = createTestDb();
  try {
    const p1 = seedProject(t.db, { key: 'ONE', repoPath: makeTempDir() }); const p2 = seedProject(t.db, { key: 'TWO', repoPath: makeTempDir() });
    const a = seedStory(t.db, p1.id); const b = seedStory(t.db, p2.id, { key: 'TWO-1' });
    const createdAt = new Date(2026, 10, 8, 12);
    t.db.insert(modelUsage).values([
      { projectId: p1.id, storyId: a.id, costUsd: 0.1, costSource: 'reported', createdAt },
      { projectId: p2.id, storyId: b.id, costUsd: 0.05, costSource: 'estimated', createdAt },
      { projectId: p1.id, storyId: a.id, costSource: 'unknown', createdAt },
      { modelSlug: 'local/probe', costUsd: 0, costSource: 'free', createdAt },
    ]).run();
    const service = new UsageMetricsService({ db: t.db });
    const summary = await service.getUsageSummary();
    expect(summary.totalCostUsd).toBeCloseTo(0.15);
    expect(summary).toMatchObject({ costComplete: false, estimated: true, totalRequests: 4, successRate: 1 });
    expect(summary.byProject).toEqual(expect.arrayContaining([
      { projectId: p1.id, projectKey: 'ONE', costUsd: 0.1, runs: 2 },
      { projectId: p2.id, projectKey: 'TWO', costUsd: 0.05, runs: 1 },
    ]));
    expect(summary.byDay[0]).toMatchObject({ day: '2026-11-08', runs: 4 });
    expect((await service.getUsageSummary({ projectId: p1.id })).totalRequests).toBe(2);
    expect((await service.getUsageSummary({ storyId: a.id })).totalCostUsd).toBe(0.1);
    expect(toStoryDTO(t.db, a)).toMatchObject({ costUsd: 0.1, costComplete: false });
    expect(toStoryDTO(t.db, seedStory(t.db, p1.id, { key: 'ONE-2' }))).toMatchObject({ costUsd: null, costComplete: true });
    expect(summary.models.reduce((sum, m) => sum + m.costUsd, 0)).toBeCloseTo(0.15);
    const run = t.db.insert(agentRuns).values({ storyId: a.id, role: 'planner', attempt: 1, promptVersion: '1', opencodeVersion: '1', status: 'failed', idempotencyKey: 'failed' }).returning().get();
    t.db.insert(modelUsage).values({ agentRunId: run.id, costSource: 'unknown', createdAt }).run();
    expect((await service.getUsageSummary()).successRate).toBe(0.8);
  } finally { t.close(); }
});

it('validates and idempotently records successful test prompt probes', async () => {
  const t = await buildTestApp();
  try {
    const input = { providerId: 'custom', modelId: 'test', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 0, assistantMessages: 1, reportedCostUsd: 0.02 }, durationMs: 50 };
    const key = '91374e96-3af4-4160-9cff-9183f9a78b17';
    const response = await t.inject('POST', '/metrics/usage/probe', input, key);
    expect(response.statusCode).toBe(201); expect(response.json()).toMatchObject({ costUsd: 0.02, costSource: 'reported' });
    await t.inject('POST', '/metrics/usage/probe', input, key);
    expect(t.t.db.select().from(modelUsage).all()).toHaveLength(1);
    expect((await t.inject('GET', '/metrics/usage')).json()).toMatchObject({ totalRequests: 1, totalCostUsd: 0.02, successRate: 1 });
    expect((await t.inject('POST', '/metrics/usage/probe', { ...input, durationMs: -1 })).statusCode).toBe(400);
    expect((await t.inject('GET', '/metrics/usage?storyId=0')).statusCode).toBe(400);
  } finally { await t.app.close(); t.t.close(); }
});
