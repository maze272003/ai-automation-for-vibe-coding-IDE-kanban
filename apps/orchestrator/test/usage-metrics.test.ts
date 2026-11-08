// apps/orchestrator/test/usage-metrics.test.ts
import { agentRuns, modelProfiles, modelUsage, providers } from '@aik/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { UsageMetricsService } from '../src/metrics/usage-service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

describe('REL-5 Usage & Quota Metrics', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let service: UsageMetricsService;
  let provId1: number;
  let provId2: number;
  let modelProfId1: number;
  let modelProfId2: number;
  let projectId: number;
  let storyId: number;
  let runId: number;

  beforeAll(() => {
    dbHolder = createTestDb();
    service = new UsageMetricsService({ db: dbHolder.db });

    // Seed providers
    const p1 = dbHolder.db
      .insert(providers)
      .values({
        name: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        costClass: 'paid_metered',
        dataUse: 'no_training',
        enabled: true,
        quotaState: { remaining: 8500, exhaustedUntil: null, lastStatus: 200 },
      })
      .returning()
      .get();
    provId1 = p1.id;

    const p2 = dbHolder.db
      .insert(providers)
      .values({
        name: 'openai',
        kind: 'openai_compatible',
        baseUrl: 'https://api.openai.com',
        costClass: 'paid_metered',
        dataUse: 'no_training',
        enabled: true,
        quotaState: { remaining: 0, exhaustedUntil: Date.now() + 3600_000, lastStatus: 429 },
      })
      .returning()
      .get();
    provId2 = p2.id;

    // Seed model profiles
    const mp1 = dbHolder.db
      .insert(modelProfiles)
      .values({
        providerId: provId1,
        modelId: 'claude-3-7-sonnet',
        contextLimit: 200_000,
        outputLimit: 8192,
        enabled: true,
      })
      .returning()
      .get();
    modelProfId1 = mp1.id;

    const mp2 = dbHolder.db
      .insert(modelProfiles)
      .values({
        providerId: provId2,
        modelId: 'gpt-4o',
        contextLimit: 128_000,
        outputLimit: 4096,
        enabled: true,
      })
      .returning()
      .get();
    modelProfId2 = mp2.id;

    const repoPath = makeTempRepo({ name: 'usage-test-repo' });
    const proj = seedProject(dbHolder.db, { repoPath });
    projectId = proj.id;
    const story = seedStory(dbHolder.db, projectId, { key: 'USG-1', title: 'Usage story' });
    storyId = story.id;

    const run = dbHolder.db
      .insert(agentRuns)
      .values({
        storyId,
        role: 'implementer',
        attempt: 1,
        modelProfileId: modelProfId1,
        promptVersion: '1.0',
        opencodeVersion: '2.0.32',
        status: 'succeeded',
        idempotencyKey: 'run-usage-1',
      })
      .returning()
      .get();
    runId = run.id;
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('aggregates requests, tokens, latency, success rate and fallbacks correctly', async () => {
    const baseTime = new Date('2026-10-24T10:00:00Z');

    // Insert usage rows for profile 1 (successful requests)
    dbHolder.db.insert(modelUsage).values([
      {
        agentRunId: runId,
        projectId, storyId,
        modelProfileId: modelProfId1,
        httpStatus: 200,
        inputTokens: 1000,
        outputTokens: 200,
        latencyMs: 500,
        createdAt: new Date(baseTime.getTime() + 1000),
      },
      {
        agentRunId: runId,
        projectId, storyId,
        modelProfileId: modelProfId1,
        httpStatus: 200,
        inputTokens: 1500,
        outputTokens: 300,
        latencyMs: 700,
        createdAt: new Date(baseTime.getTime() + 2000),
      },
    ]).run();

    // Insert usage rows for profile 2 (one error 429, one fallback)
    dbHolder.db.insert(modelUsage).values([
      {
        agentRunId: runId,
        projectId, storyId,
        modelProfileId: modelProfId2,
        httpStatus: 429,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 150,
        createdAt: new Date(baseTime.getTime() + 3000),
      },
      {
        agentRunId: runId,
        projectId, storyId,
        modelProfileId: modelProfId2,
        httpStatus: 200,
        inputTokens: 2000,
        outputTokens: 400,
        latencyMs: 650,
        fallbackFrom: modelProfId1,
        createdAt: new Date(baseTime.getTime() + 4000),
      },
    ]).run();

    const summary = await service.getUsageSummary();

    expect(summary.totalRequests).toBe(4);
    expect(summary.totalInputTokens).toBe(4500); // 1000 + 1500 + 0 + 2000
    expect(summary.totalOutputTokens).toBe(900); // 200 + 300 + 0 + 400
    expect(summary.avgLatencyMs).toBe(500); // (500 + 700 + 150 + 650) / 4 = 2000 / 4 = 500
    expect(summary.successRate).toBe(0.75); // 3 of 4 succeeded
    expect(summary.fallbackCount).toBe(1);

    // Breakdown by model
    const m1 = summary.models.find((m) => m.modelProfileId === modelProfId1);
    expect(m1).toBeDefined();
    expect(m1?.modelId).toBe('claude-3-7-sonnet');
    expect(m1?.requests).toBe(2);
    expect(m1?.inputTokens).toBe(2500);
    expect(m1?.outputTokens).toBe(500);
    expect(m1?.avgLatencyMs).toBe(600);
    expect(m1?.errorCount).toBe(0);

    const m2 = summary.models.find((m) => m.modelProfileId === modelProfId2);
    expect(m2).toBeDefined();
    expect(m2?.modelId).toBe('gpt-4o');
    expect(m2?.requests).toBe(2);
    expect(m2?.inputTokens).toBe(2000);
    expect(m2?.outputTokens).toBe(400);
    expect(m2?.errorCount).toBe(1);
    expect(m2?.fallbackCount).toBe(1);

    // Quotas list
    const q1 = summary.quotas.find((q) => q.provider === 'anthropic');
    expect(q1?.remaining).toBe(8500);
    expect(q1?.exhaustedUntil).toBeNull();

    const q2 = summary.quotas.find((q) => q.provider === 'openai');
    expect(q2?.remaining).toBe(0);
    expect(q2?.exhaustedUntil).toBeGreaterThan(0);
  });

  test('filters usage by date range and project', async () => {
    const from = new Date('2026-10-24T10:00:01.500Z');
    const to = new Date('2026-10-24T10:00:03.500Z');

    const filtered = await service.getUsageSummary({ from, to });
    expect(filtered.totalRequests).toBe(2); // rows at +2000 and +3000

    const byProj = await service.getUsageSummary({ projectId });
    expect(byProj.totalRequests).toBe(4);

    const nonExistentProj = await service.getUsageSummary({ projectId: 9999 });
    expect(nonExistentProj.totalRequests).toBe(0);
  });

  test('strict security invariant: no prompt or completion text is ever returned in metrics', async () => {
    const summary = await service.getUsageSummary();
    const serialized = JSON.stringify(summary).toLowerCase();

    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('completion');
    expect(serialized).not.toContain('messages');
    expect(serialized).not.toContain('conversation');
  });

  test('GET /metrics/usage route returns valid UsageSummaryDTO', async () => {
    const { registerMetricsRoutes } = await import('../src/api/routes/metrics.ts');
    const { default: Fastify } = await import('fastify');
    const app = Fastify();
    registerMetricsRoutes(app, { metrics: service, db: dbHolder.db, now: Date.now });

    const res = await app.inject({
      method: 'GET',
      url: `/metrics/usage?projectId=${projectId}`,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.totalRequests).toBe(4);
    expect(json.totalInputTokens).toBe(4500);
    expect(json.models).toHaveLength(2);
    expect(json.quotas).toHaveLength(2);
  });
});
