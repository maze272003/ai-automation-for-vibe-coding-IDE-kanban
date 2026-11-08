// apps/orchestrator/src/api/routes/maintenance.ts
import {
  DIAGNOSTICS_RESTORE_NOTE,
  DiagnosticsErrorsQuery,
  DiagnosticsLogParams,
  DiagnosticsLogQuery,
} from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { DiagnosticsService } from '../../maintenance/diagnostics.ts';
import type { RetentionService } from '../../maintenance/retention.ts';
import type { Clock } from '../../time.ts';
import { ApiHttpError } from '../errors.ts';
import { mutation, parse } from '../idempotency.ts';

export function registerMaintenanceRoutes(
  app: FastifyInstance,
  // `db`/`now` are optional so a caller that only serves prune/export keeps compiling;
  // the on-demand backup mutation needs them for idempotency persistence.
  deps: { retention: RetentionService; diagnostics: DiagnosticsService; db?: AikDb; now?: Clock },
): void {
  app.post<{ Body: { maxAgeDays?: number } }>('/maintenance/prune', async (req, reply) => {
    const result = await deps.retention.prune(req.body ?? {});
    return reply.send({ ok: true, ...result });
  });

  app.get('/diagnostics/export', async (_req, reply) => {
    const archive = await deps.diagnostics.exportArchive();
    return reply.send(archive);
  });

  app.get('/diagnostics/health', async () => deps.diagnostics.health());

  app.get('/diagnostics/errors', async (req) =>
    deps.diagnostics.recentErrors(parse(DiagnosticsErrorsQuery, req.query).limit),
  );

  app.get('/diagnostics/logs', async () => ({ files: deps.diagnostics.listLogs() }));

  app.get<{ Params: { file: string } }>('/diagnostics/logs/:file', async (req) => {
    const { file } = parse(DiagnosticsLogParams, req.params);
    const { tailBytes } = parse(DiagnosticsLogQuery, req.query);
    const log = deps.diagnostics.readLog(file, tailBytes);
    if (log === null) throw new ApiHttpError(404, 'NOT_FOUND', `Unknown log file: ${file}`);
    return log;
  });

  app.get('/diagnostics/backups', async () => ({
    backups: deps.diagnostics.listBackups(),
    restoreNote: DIAGNOSTICS_RESTORE_NOTE,
  }));

  const db = deps.db;
  const now = deps.now;
  if (db !== undefined && now !== undefined) {
    mutation(app, { db, now }, 'POST', '/diagnostics/backup', async () => ({
      status: 200,
      body: await deps.diagnostics.createBackup(),
    }));
  }
}
