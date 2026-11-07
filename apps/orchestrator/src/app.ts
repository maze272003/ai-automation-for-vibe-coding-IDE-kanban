// apps/orchestrator/src/app.ts
import type { OfficeConfig } from '@aik/contracts';
import { openDatabase } from '@aik/db';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ImplementerAgent } from './agents/implementer.ts';
import { RunInterruptRegistry } from './agents/interrupts.ts';
import { PlannerAgent } from './agents/planner.ts';
import { ReviewerAgent } from './agents/reviewer.ts';
import { AgentRunner } from './agents/runner.ts';
import { OpenCodeRuntime } from './agents/runtime.ts';
import { registerEventRoutes } from './api/routes/events.ts';
import { registerFileRoutes } from './api/routes/files.ts';
import { registerGitHubRoutes } from './api/routes/github.ts';
import { registerGitViewRoutes } from './api/routes/git-view.ts';
import { registerHealthRoutes } from './api/routes/health.ts';
import { registerMaintenanceRoutes } from './api/routes/maintenance.ts';
import { registerMetricsRoutes } from './api/routes/metrics.ts';
import { registerProviderRoutes } from './api/routes/providers.ts';
import { registerProjectRoutes } from './api/routes/projects.ts';
import { registerStoryRoutes } from './api/routes/stories.ts';
import { createApiServer } from './api/server.ts';
import { DiagnosticsService } from './maintenance/diagnostics.ts';
import { RetentionService } from './maintenance/retention.ts';
import { UsageMetricsService } from './metrics/usage-service.ts';
import { dataPaths } from './config.ts';
import { EventBus } from './events/bus.ts';
import { WorkspaceFileService } from './files/service.ts';
import { startGateway } from './gateway/server.ts';
import { createCredentialStore } from './github/credentials.ts';
import { GitHubCloneService } from './github/clone-service.ts';
import { GitHubMergeService } from './github/merge-service.ts';
import { GitHubPRPoller } from './github/pr-poller.ts';
import { GitHubPublishService } from './github/publish-service.ts';
import { GitHubRepositoryService } from './github/repository-service.ts';
import { GitHubAuthService } from './github/service.ts';
import { GitHubSyncService } from './github/sync-service.ts';
import { LocalMerger } from './git/merger.ts';
import { GitViewService } from './git/view-service.ts';
import { WorktreeManager } from './git/worktree.ts';
import { JobQueue } from './jobs/queue.ts';
import { createLogger } from './logging/logger.ts';
import { PixelAgentsBridge } from './office/bridge.ts';
import { registerOfficeRoutes } from './api/routes/office.ts';
import { buildOfficeSnapshot } from './office/snapshot.ts';
import { OfficeRoomService } from './office/room-service.ts';
import { ProjectService } from './projects/service.ts';
import { projectBusyReason } from './projects/busy.ts';
import { ProviderService } from './providers/service.ts';
import { createProviderVault } from './providers/vault.ts';
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
  /**
   * The per-run model-gateway token (spec PK-2/PK-3). The desktop generates a fresh random
   * value for every app run, holds it only in memory and passes it in managed mode. Its
   * presence switches the whole provider stack on (vault, provider routes, loopback gateway
   * and the stored default model driving the agent runtime); when it is absent — personal
   * mode — none of that wiring exists, so personal behaviour stays byte-identical.
   */
  gatewayToken?: string;
  /**
   * Pixel Agents office server (spec 2026-11-04). Presence constructs the run→hook-event
   * bridge; absence means the feature is off and no office wiring exists at all.
   */
  agentOffice?: OfficeConfig;
  /**
   * The environment the orchestrator reads its settings from (default `process.env`). Later
   * tasks resolve agent binaries and detection from it, so tests pass an explicit environment
   * instead of stubbing the global one.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Read-only test seam (composition-root rule, plan 6.1a-21): the objects `startOrchestrator()`
 * actually built, so `app-wiring.test.ts` inspects the real composition — nothing re-created.
 */
export interface OrchestratorWiring {
  readonly runner: AgentRunner;
}

export interface RunningOrchestrator {
  port: number;
  /** Loopback port of the model gateway; null when the orchestrator runs without one. */
  gatewayPort: number | null;
  readonly wiring: OrchestratorWiring;
  close(): Promise<void>;
}

export async function startOrchestrator(opts: OrchestratorOptions): Promise<RunningOrchestrator> {
  const env = opts.env ?? process.env;
  const paths = dataPaths(opts.dataDir);
  fs.mkdirSync(paths.logs, { recursive: true });
  const redactor = createRedactor();
  redactor.addSecret(opts.token);
  // The gateway token is a secret with gateway-only power (PK-2): upstream client errors can
  // echo full URLs, so register it with the redactor like the API token. Only set when passed.
  if (opts.gatewayToken) redactor.addSecret(opts.gatewayToken);
  // The office token is a bearer capability for the local Pixel Agents server: register it so
  // no log line or persisted error can leak it (spec 2026-11-04 security review).
  if (opts.agentOffice) redactor.addSecret(opts.agentOffice.token);
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

  // Worktree purge wiring mirrors buildTestApp one-to-one: DELETE /projects/:id discards the
  // app-generated worktrees via the same manager used for isolation before the DB purge runs
  // (their workspaces rows go first, so purgeForProject must run before purgeProjectData).
  const worktreeManager = new WorktreeManager({ rootDir: paths.worktrees, db });
  const rooms = new OfficeRoomService({ db, bus });
  const projects = new ProjectService({
    db,
    rooms,
    worktreePurge: (input) => worktreeManager.purgeForProject(input),
    // Spec §4.3: every sanctioned purge leaves an audit line in logs/audit-purge.log. The line
    // carries counts/keys only (built in ProjectService.delete), never secrets; the logs dir is
    // created at startup above, so the synchronous append always has a target.
    purgeLog: (line) => fs.appendFileSync(path.join(paths.logs, 'audit-purge.log'), `${line}\n`),
  });
  // Provider stack (spec PK-1..PK-4), gated on the per-run gateway token: managed mode only.
  // Ordering matters — the vault feeds the service, the service feeds the routes, the
  // default-model lookup feeds the runtime, and the gateway is started once ports are bound.
  // In personal mode (no token) none of this is constructed and the runtime is created
  // exactly as before.
  const providerVault = opts.gatewayToken === undefined ? null : createProviderVault();
  const providerService =
    providerVault === null ? null : new ProviderService({ db, vault: providerVault, now: systemClock });
  const storedDefault = providerService?.getDefaultModel() ?? null;
  const runtime = new OpenCodeRuntime(
    storedDefault ? { defaultModel: { providerID: storedDefault.providerId, id: storedDefault.modelId } } : {},
  );
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

  const gitView = new GitViewService({
    db,
    projects,
    busy: (projectId) => projectBusyReason(db, projectId),
    accessToken: async () => {
      try {
        const auth = await github.getValidAccessToken();
        return auth?.token ?? null;
      } catch {
        return null;
      }
    },
  });
  const files = new WorkspaceFileService({
    projects,
    busy: (projectId) => projectBusyReason(db, projectId),
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
  const planner = new PlannerAgent({ db, workflow, bus, runtime, interrupts, skills, redact: redactor.redact });
  const implementer = new ImplementerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills, redact: redactor.redact });
  const reviewer = new ReviewerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills, redact: redactor.redact });
  // Pixel Agents office bridge (spec 2026-11-04): only exists when the desktop passed the
  // office server config — feature off means no subscriber, no sockets, no processes.
  const officeBridge = opts.agentOffice
    ? new PixelAgentsBridge({ db, bus, logger, redact: redactor.redact, office: opts.agentOffice })
    : null;
  officeBridge?.start();
  // How many repositories may be worked on at the same time (spec ADV-1). The cap keeps one
  // machine from running more model sessions and test suites at once than it can carry.
  const maxConcurrentLanes = Number.parseInt(env.AIK_MAX_CONCURRENT_LANES ?? '', 10);
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
    logger,
    redact: redactor.redact,
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
  registerOfficeRoutes(app, { db, now: systemClock, rooms, snapshot: () => buildOfficeSnapshot(db, systemClock) });
  registerGitViewRoutes(app, { db, now: systemClock, gitView });
  registerFileRoutes(app, { db, now: systemClock, files });
  // Root-relative `/providers` + `/settings/default-model` routes; only wired in managed mode.
  if (providerService) {
    registerProviderRoutes(app, { db, now: systemClock, providers: providerService });
  }
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
  const usageMetrics = new UsageMetricsService({ db });
  registerMetricsRoutes(app, { metrics: usageMetrics });
  const retention = new RetentionService({ db, worktreeRoot: paths.worktrees, logsDir: paths.logs });
  const diagnostics = new DiagnosticsService({ db, logsDir: paths.logs, version: opts.versions?.app, redactor });
  registerMaintenanceRoutes(app, { retention, diagnostics });
  registerEventRoutes(app, { db, bus, heartbeatMs: opts.heartbeatMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;

  // The loopback model gateway (spec PK-3): binds 127.0.0.1 with an ephemeral port, speaks to
  // OpenCode with the per-run gateway token and only this token. The provider API key never
  // passes through it into any config/stream reachable by OpenCode — the gateway injects it
  // at the last moment (Task 6). It starts with the orchestrator and is closed by `close()`
  // below; it never starts in personal mode.
  const gateway =
    providerVault && providerService && opts.gatewayToken
      ? await startGateway({
          token: opts.gatewayToken,
          providers: providerService,
          vault: providerVault,
          redact: redactor.redact,
          logger: { info: (obj, msg) => logger.info(obj as Record<string, unknown>, msg), warn: (obj, msg) => logger.warn(obj as Record<string, unknown>, msg) },
        })
      : null;
  logger.info({ port, gatewayPort: gateway?.port ?? null, recovered: swept }, 'orchestrator listening');

  return {
    port,
    gatewayPort: gateway?.port ?? null,
    wiring: Object.freeze({ runner }),
    close: async () => {
      clearInterval(pollTimer);
      if (gateway) await gateway.close();
      officeBridge?.stop();
      runner.stop();
      await app.close();
      opened.close();
      logger.info('orchestrator stopped');
      closeLog();
    },
  };
}
