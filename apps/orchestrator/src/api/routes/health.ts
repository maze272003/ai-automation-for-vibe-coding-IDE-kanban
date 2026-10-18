// apps/orchestrator/src/api/routes/health.ts
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: AikDb; versions: { app: string; electron: string | null; node: string }; dataDir: string },
): void {
  app.get('/health', async () => {
    let db: 'ok' | 'error' = 'ok';
    try {
      deps.db.$client.prepare('SELECT 1').get();
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      versions: { ...deps.versions, opencode: null },
      components: { db },
      dataDir: deps.dataDir,
    };
  });
}
