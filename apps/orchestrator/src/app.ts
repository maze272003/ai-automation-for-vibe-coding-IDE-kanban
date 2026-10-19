// apps/orchestrator/src/app.ts
import { openDatabase } from '@aik/db';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ImplementerAgent } from './agents/implementer.ts';
import { PlannerAgent } from './agents/planner.ts';
import { AgentRunner } from './agents/runner.ts';
import { OpenCodeRuntime } from './agents/runtime.ts';
import { registerEventRoutes } from './api/routes/events.ts';
import { registerHealthRoutes } from './api/routes/health.ts';
import { registerProjectRoutes } from './api/routes/projects.ts';
import { registerStoryRoutes } from './api/routes/stories.ts';
import { createApiServer } from './api/server.ts';
import { dataPaths } from './config.ts';
import { EventBus } from './events/bus.ts';
import { WorktreeManager } from './git/worktree.ts';
import { JobQueue } from './jobs/queue.ts';
import { createLogger } from './logging/logger.ts';
import { ProjectService } from './projects/service.ts';
import { createRedactor } from './secrets/redactor.ts';
import { StoryService } from './stories/service.ts';
import { systemClock } from './time.ts';
import { WorkflowService } from './workflow/service.ts';

export interface OrchestratorOptions {
  dataDir: string;
  token: string;
  migrationsFolder: string;
  versions: { app: string; electron: string | null };
  logLevel?: string;
  heartbeatMs?: number;
}

export interface RunningOrchestrator {
  port: number;
  close(): Promise<void>;
}

export async function startOrchestrator(opts: OrchestratorOptions): Promise<RunningOrchestrator> {
  const paths = dataPaths(opts.dataDir);
  fs.mkdirSync(paths.logs, { recursive: true });
  const redactor = createRedactor();
  redactor.addSecret(opts.token);
  const { logger, close: closeLog } = createLogger({ file: paths.orchestratorLog, redactor, level: opts.logLevel });

  let opened: ReturnType<typeof openDatabase>;
  try {
    opened = openDatabase({ file: paths.db, backupsDir: paths.backups, migrationsFolder: opts.migrationsFolder });
  } catch (err) {
    logger.error({ err }, 'database open failed');
    closeLog();
    throw err;
  }
  const db = opened.db;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db, bus, redact: redactor.redact });
  const queue = new JobQueue(db);

  // Startup recovery (spec §6.10): side-effecting jobs whose lease expired are never re-run automatically.
  const swept = queue.sweepExpired();
  for (const job of swept.interrupted) {
    if (job.storyId === null) continue;
    const r = workflow.transition({
      storyId: job.storyId,
      event: { type: 'fail', reason: 'interrupted', detail: `The ${job.kind} job ${job.jobId} was interrupted by an orchestrator restart` },
      actor: 'system',
    });
    if (!r.ok) logger.warn({ jobId: job.jobId, storyId: job.storyId, code: r.code }, 'could not block story for interrupted job');
  }

  const projects = new ProjectService({ db });
  await projects.refreshAvailability();
  const stories = new StoryService({ db, workflow, bus, queue });

  const worktreeManager = new WorktreeManager({ rootDir: paths.worktrees });
  const runtime = new OpenCodeRuntime();
  const planner = new PlannerAgent({ db, workflow, bus, runtime });
  const implementer = new ImplementerAgent({ db, workflow, bus, runtime, worktreeManager });
  const runner = new AgentRunner({ db, queue, workflow, bus, planner, implementer });
  runner.start();

  let port = 0;
  const app = createApiServer({ token: opts.token, getPort: () => port, logger });
  registerHealthRoutes(app, { db, versions: { ...opts.versions, node: process.versions.node }, dataDir: opts.dataDir });
  registerProjectRoutes(app, { db, now: systemClock, projects });
  registerStoryRoutes(app, { db, now: systemClock, stories });
  registerEventRoutes(app, { db, bus, heartbeatMs: opts.heartbeatMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  logger.info({ port, recovered: swept }, 'orchestrator listening');

  return {
    port,
    close: async () => {
      runner.stop();
      await app.close();
      opened.close();
      logger.info('orchestrator stopped');
      closeLog();
    },
  };
}
