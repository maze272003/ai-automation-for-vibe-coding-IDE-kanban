// apps/orchestrator/src/api/routes/metrics.ts
import type { FastifyInstance } from 'fastify';
import type { AikDb } from '@aik/db';
import type { Clock } from '../../time.ts';
import { recordUsage } from '../../metrics/record-usage.ts';
import { mutation, parse } from '../idempotency.ts';
import { z } from 'zod';
import type { UsageMetricsService } from '../../metrics/usage-service.ts';

export const UsageQuerySchema = z.object({
  storyId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

export function registerMetricsRoutes(
  app: FastifyInstance,
  deps: { metrics: UsageMetricsService; db: AikDb; now: Clock },
): void {
  mutation(app, deps, 'POST', '/metrics/usage/probe', async (req) => {
    const input = parse(UsageProbeSchema, req.body);
    return { status: 201, body: recordUsage(deps.db, new Date(deps.now()), { ...input, runtime: 'opencode', agentRunId: null, storyId: null, projectId: null, modelProfileId: null }) };
  });
  app.get('/metrics/usage', async (req) => {
    const query = parse(UsageQuerySchema, req.query ?? {});
    return deps.metrics.getUsageSummary(query);
  });
}

const Count = z.number().int().nonnegative();
const UsageProbeSchema = z.object({
  providerId: z.string().min(1).max(500), modelId: z.string().min(1).max(500),
  durationMs: Count.nullable(),
  usage: z.object({ inputTokens: Count, outputTokens: Count, reasoningTokens: Count,
    cachedInputTokens: Count, assistantMessages: Count, reportedCostUsd: z.number().nonnegative().nullable() }).nullable(),
}).strict();
