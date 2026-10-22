// apps/orchestrator/src/app.ts
import { openDatabase } from '@aik/db';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ImplementerAgent } from './agents/implementer.ts';
import { RunInterruptRegistry } from './agents/interrupts.ts';
import { PlannerAgent } from './agents/planner.ts';
import { ReviewerAgent } from './agents/reviewer.ts';
import { AgentRunner } from './agents/runner.ts';
import { OpenCodeRuntime } from './agents/runtime.ts';
import { registerEventRoutes } from './api/routes/events.ts';
import { registerGitHubRoutes } from './api/routes/github.ts';
import { registerHealthRoutes } from './api/routes/health.ts';
import { registerProjectRoutes } from './api/routes/projects.ts';
import { registerStoryRoutes } from './api/routes/stories.ts';
import { createApiServer } from './api/server.ts';
import { dataPaths } from './config.ts';
import { EventBus } from './events/bus.ts';
import { createCredentialStore } from './github/credentials.ts';
import { GitHubCloneService } from './github/clone-service.ts';
import { GitHubMergeService } from './github/merge-service.ts';
import { GitHubPRPoller } from './github/pr-poller.ts';
import { GitHubPublishService } from './github/publish-service.ts';
import { GitHubRepositoryService } from './github/repository-service.ts';
import { GitHubAuthService } from './github/service.ts';
import { GitHubSyncService } from './github/sync-service.ts';
import { LocalMerger } from './git/merger.ts';
import { WorktreeManager } from './git/worktree.ts';
import { JobQueue } from './jobs/queue.ts';
import { createLogger } from './logging/logger.ts';
import { ProjectService } from './projects/service.ts';
import { createRedactor } from './secrets/redactor.ts';
import { StoryService } from './stories/service.ts';
import { systemClock } from './time.ts';
import { VerificationRunner } from './verify/runner.ts';
import { WorkflowService } from './workflow/service.ts';
import { SkillBridgeService } from './skills/bridge.ts';
import { pullRequests } from '@aik/db';
import { eq } from 'drizzle-orm';

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
  // EXE-13: the single registry of interruptible in-flight work. The workflow fires
  // onRunInterrupt after a stop_run/cancel/fail commit; agents and verification register handles.
  const interrupts = new RunInterruptRegistry();
  const workflow = new WorkflowService({
    db,
    bus,
    redact: redactor.redact,
    onRunInterrupt: (storyId) => void interrupts.requestStop(storyId),
  });
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
  const worktreeManager = new WorktreeManager({ rootDir: paths.worktrees, db });
  const runtime = new OpenCodeRuntime();
  const verification = new VerificationRunner({ db, workflow, bus, worktreeManager, logsDir: paths.logs, redact: redactor.redact, interrupts });
  const merger = new LocalMerger({ db, workflow, bus, worktreeManager, verification, redact: redactor.redact });

  const credentials = createCredentialStore();
  const github = new GitHubAuthService({ db, credentials, now: systemClock });
  const githubRepos = new GitHubRepositoryService({ db, authService: github, now: systemClock });
  const githubClone = new GitHubCloneService({
    db,
    authService: github,
    repoService: githubRepos,
    projectService: projects,
    now: systemClock,
  });
  const githubSync = new GitHubSyncService({
    db,
    authService: github,
    workflow,
    bus,
    now: systemClock,
    redact: redactor.redact,
  });
  const githubPublish = new GitHubPublishService({
    db,
    authService: github,
    now: systemClock,
    redact: redactor.redact,
  });
  const githubPoller = new GitHubPRPoller({
    db,
    authService: github,
    workflow,
    bus,
    now: systemClock,
    redact: redactor.redact,
  });
  const githubMerge = new GitHubMergeService({
    db,
    authService: github,
    poller: githubPoller,
    workflow,
    bus,
    verification,
    now: systemClock,
    redact: redactor.redact,
  });

  const stories = new StoryService({
    db,
    workflow,
    bus,
    queue,
    merger,
    publishService: githubPublish,
    poller: githubPoller,
    syncService: githubSync,
    remoteMerger: githubMerge,
  });

  const skills = new SkillBridgeService({ logger: (msg) => logger.info({ msg }, 'skill-bridge') });
  const planner = new PlannerAgent({ db, workflow, bus, runtime, interrupts, skills });
  const implementer = new ImplementerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills });
  const reviewer = new ReviewerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills });
  // How many repositories may be worked on at the same time (spec ADV-1). The cap keeps one
  // machine from running more model sessions and test suites at once than it can carry.
  const maxConcurrentLanes = Number.parseInt(process.env.AIK_MAX_CONCURRENT_LANES ?? '', 10);
  const runner = new AgentRunner({
    db,
    queue,
    workflow,
    bus,
    planner,
    implementer,
    verification,
    reviewer,
    merger,
    remoteMerger: githubMerge,
    ...(Number.isInteger(maxConcurrentLanes) && maxConcurrentLanes > 0 ? { maxConcurrentLanes } : {}),
  });
  runner.start();

  // 60-second background polling for open PRs
  const pollTimer = setInterval(async () => {
    try {
      const openPrs = db.select({ id: pullRequests.id }).from(pullRequests).where(eq(pullRequests.state, 'open')).all();
      for (const pr of openPrs) {
        await githubPoller.pollPullRequest(pr.id);
      }
    } catch {
      // non-fatal background poll error
    }
  }, 60_000);
  pollTimer.unref?.();

  let port = 0;
  const app = createApiServer({ token: opts.token, getPort: () => port, logger });
  registerHealthRoutes(app, { db, versions: { ...opts.versions, node: process.versions.node }, dataDir: opts.dataDir });
  registerProjectRoutes(app, { db, now: systemClock, projects });
  registerStoryRoutes(app, { db, now: systemClock, stories });
  registerGitHubRoutes(app, {
    db,
    now: systemClock,
    github,
    githubRepos,
    githubClone,
    githubSync,
    githubPublish,
    githubPoller,
    githubMerge,
  });
  registerEventRoutes(app, { db, bus, heartbeatMs: opts.heartbeatMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  logger.info({ port, recovered: swept }, 'orchestrator listening');

  return {
    port,
    close: async () => {
      clearInterval(pollTimer);
      runner.stop();
      await app.close();
      opened.close();
      logger.info('orchestrator stopped');
      closeLog();
    },
  };
}
