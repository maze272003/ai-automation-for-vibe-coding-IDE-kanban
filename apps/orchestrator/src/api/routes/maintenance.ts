// apps/orchestrator/src/api/routes/maintenance.ts
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsService } from '../../maintenance/diagnostics.ts';
import type { RetentionService } from '../../maintenance/retention.ts';

export function registerMaintenanceRoutes(
  app: FastifyInstance,
  deps: { retention: RetentionService; diagnostics: DiagnosticsService },
): void {
  app.post<{ Body: { maxAgeDays?: number } }>('/maintenance/prune', async (req, reply) => {
    const result = await deps.retention.prune(req.body ?? {});
    return reply.send({ ok: true, ...result });
  });

  app.get('/diagnostics/export', async (_req, reply) => {
    const archive = await deps.diagnostics.exportArchive();
    return reply.send(archive);
  });
}
