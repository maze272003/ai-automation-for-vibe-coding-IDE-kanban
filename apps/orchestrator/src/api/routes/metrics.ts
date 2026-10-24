// apps/orchestrator/src/api/routes/metrics.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsageMetricsService } from '../../metrics/usage-service.ts';

export const UsageQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

export function registerMetricsRoutes(
  app: FastifyInstance,
  deps: { metrics: UsageMetricsService },
): void {
  app.get('/metrics/usage', async (req) => {
    const query = UsageQuerySchema.parse(req.query ?? {});
    return deps.metrics.getUsageSummary(query);
  });
}
