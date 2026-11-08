// apps/orchestrator/test/retention-diagnostics.test.ts
import {
  durableJobs,
  mergeApprovals,
  modelUsage,
  outboxEvents,
  reviews,
  storyEvents,
  verificationChecks,
  verificationRuns,
  workspaces,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { registerMaintenanceRoutes } from '../src/api/routes/maintenance.ts';
import { createApiServer } from '../src/api/server.ts';
import { DiagnosticsService } from '../src/maintenance/diagnostics.ts';
import { RetentionService } from '../src/maintenance/retention.ts';
import { scanText } from '../src/secrets/scan.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('REL-7 Retention Pruning & Diagnostics Export', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let retentionService: RetentionService;
  let diagnosticsService: DiagnosticsService;
  let worktreeRoot: string;
  let logsDir: string;
  let projectId: number;
  let storyId: number;

  beforeAll(() => {
    dbHolder = createTestDb();
    worktreeRoot = makeTempDir('retention-wt-root-');
    logsDir = makeTempDir('retention-logs-');

    retentionService = new RetentionService({
      db: dbHolder.db,
      worktreeRoot,
      logsDir,
    });

    diagnosticsService = new DiagnosticsService({
      db: dbHolder.db,
      logsDir,
      version: '0.1.0',
    });

    const repoPath = makeTempRepo({ name: 'retention-repo' });
    const project = seedProject(dbHolder.db, { repoPath });
    projectId = project.id;
    const story = seedStory(dbHolder.db, projectId, { key: 'RET-1', title: 'Retention Story' });
    storyId = story.id;
  });

  afterAll(() => {
    dbHolder.close();
  });

  test('keeps retry evidence for live stories and retains historical usage', async () => {
    const oldDate = new Date(Date.now() - 40 * 86400 * 1000);
    const live = seedStory(dbHolder.db, projectId, { status: 'REWORK' });
    const done = seedStory(dbHolder.db, projectId, { status: 'DONE' });
    const cases = [
      { storyId: live.id, status: 'failed' as const, keep: true },
      { storyId: done.id, status: 'failed' as const, keep: false },
      { storyId: live.id, status: 'succeeded' as const, keep: false },
      { storyId: null, status: 'dead' as const, keep: false },
    ];
    const jobs = cases.map((entry, index) => ({
      ...entry,
      row: dbHolder.db.insert(durableJobs).values({
        kind: 'verify', slot: 'light', storyId: entry.storyId, status: entry.status,
        payload: {}, sideEffecting: false, runAfter: oldDate,
        idempotencyKey: `retention-evidence-${index}`, createdAt: oldDate, updatedAt: oldDate,
      }).returning().get(),
    }));
    const usage = dbHolder.db.insert(modelUsage).values({
      storyId: live.id, projectId, createdAt: oldDate, costSource: 'unknown',
    }).returning().get();
    await retentionService.prune();
    for (const { row, keep } of jobs) {
      expect(Boolean(dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, row.id)).get())).toBe(keep);
    }
    expect(dbHolder.db.select().from(modelUsage).where(eq(modelUsage.id, usage.id)).get()).toBeDefined();
  });

  test('prunes expired jobs, outbox events, and removed workspaces past retention window', async () => {
    const oldDate = new Date(Date.now() - 40 * 86400 * 1000); // 40 days old
    const recentDate = new Date(Date.now() - 5 * 86400 * 1000); // 5 days old

    // Seed expired durable job
    const oldJob = dbHolder.db
      .insert(durableJobs)
      .values({
        kind: 'verify',
        slot: 'light',
        storyId,
        payload: {},
        sideEffecting: false,
        status: 'succeeded',
        runAfter: oldDate,
        idempotencyKey: 'old-job-idem',
        createdAt: oldDate,
        updatedAt: oldDate,
      })
      .returning()
      .get();

    // Seed recent durable job
    const recentJob = dbHolder.db
      .insert(durableJobs)
      .values({
        kind: 'verify',
        slot: 'light',
        storyId,
        payload: {},
        sideEffecting: false,
        status: 'succeeded',
        runAfter: recentDate,
        idempotencyKey: 'recent-job-idem',
        createdAt: recentDate,
        updatedAt: recentDate,
      })
      .returning()
      .get();

    // Seed expired outbox event
    const oldEvent = dbHolder.db
      .insert(outboxEvents)
      .values({
        topic: 'story.status',
        storyId,
        payload: { provenance: 'retention-test', data: { kind: 'status_changed', storyKey: 'RET-1' } },
        createdAt: oldDate,
      })
      .returning()
      .get();

    // Create a removed workspace with directory on disk
    const oldWorkspacePath = path.join(worktreeRoot, 'RET-1.old');
    fs.mkdirSync(oldWorkspacePath, { recursive: true });
    fs.writeFileSync(path.join(oldWorkspacePath, 'dummy.txt'), 'old workspace');

    dbHolder.db.insert(workspaces).values({
      storyId,
      kind: 'story',
      path: oldWorkspacePath,
      status: 'removed',
      createdAt: oldDate,
      removedAt: oldDate,
    }).run();

    // Prune with 30-day threshold
    const result = await retentionService.prune({ maxAgeDays: 30 });

    expect(result.prunedJobs).toBeGreaterThanOrEqual(1);
    expect(result.prunedOutboxEvents).toBeGreaterThanOrEqual(1);
    expect(result.prunedWorkspaces).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(oldWorkspacePath)).toBe(false);

    // Old job and event should be deleted
    expect(dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, oldJob.id)).get()).toBeUndefined();
    expect(dbHolder.db.select().from(outboxEvents).where(eq(outboxEvents.seq, oldEvent.seq)).get()).toBeUndefined();

    // Recent job must be preserved
    expect(dbHolder.db.select().from(durableJobs).where(eq(durableJobs.id, recentJob.id)).get()).toBeDefined();
  });

  test('strictly preserves immutable audit tables (reviews, merges, story_events, verification_checks)', async () => {
    const ancientDate = new Date(Date.now() - 365 * 86400 * 1000); // 1 year old

    // Seed immutable verification run & check
    const vRun = dbHolder.db
      .insert(verificationRuns)
      .values({
        storyId,
        commitSha: 'a'.repeat(40),
        trigger: 'candidate',
        status: 'passed',
        startedAt: ancientDate,
        endedAt: ancientDate,
      })
      .returning()
      .get();

    const vCheck = dbHolder.db
      .insert(verificationChecks)
      .values({
        verificationRunId: vRun.id,
        checkKey: 'ancient-lint',
        mandatory: true,
        status: 'passed',
        command: 'npm run lint',
        cwd: worktreeRoot,
        exitCode: 0,
        outputTail: 'lint clean',
        startedAt: ancientDate,
        endedAt: ancientDate,
      })
      .returning()
      .get();

    // Seed immutable records
    const rev = dbHolder.db
      .insert(reviews)
      .values({
        storyId,
        actor: 'human',
        agentRunId: null,
        commitSha: 'c'.repeat(40),
        rawVerdict: 'APPROVED',
        verdict: 'APPROVED',
        summary: 'Permanent audit record',
        raw: {
          schemaVersion: 1,
          verdict: 'APPROVED',
          summary: 'Permanent audit record',
          acChecklist: [],
          findings: [],
          priorFindings: [],
        },
        createdAt: ancientDate,
      })
      .returning()
      .get();

    const approval = dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId,
        kind: 'merge',
        commitSha: 'd'.repeat(40),
        approver: 'admin-auditor',
        approvedAt: ancientDate,
      })
      .returning()
      .get();

    const evt = dbHolder.db
      .insert(storyEvents)
      .values({
        storyId,
        type: 'status_changed',
        actor: 'user',
        fromStatus: 'IN_PROGRESS',
        toStatus: 'TESTING',
        createdAt: ancientDate,
      })
      .returning()
      .get();

    // Run aggressive prune (0 days retention)
    await retentionService.prune({ maxAgeDays: 0 });

    // Verify all immutable records are 100% untouched
    expect(dbHolder.db.select().from(reviews).where(eq(reviews.id, rev.id)).get()).toBeDefined();
    expect(dbHolder.db.select().from(mergeApprovals).where(eq(mergeApprovals.id, approval.id)).get()).toBeDefined();
    expect(dbHolder.db.select().from(storyEvents).where(eq(storyEvents.id, evt.id)).get()).toBeDefined();
    expect(dbHolder.db.select().from(verificationRuns).where(eq(verificationRuns.id, vRun.id)).get()).toBeDefined();
    expect(dbHolder.db.select().from(verificationChecks).where(eq(verificationChecks.id, vCheck.id)).get()).toBeDefined();
  });

  test('diagnostics export generates sanitized archive free of any secrets', async () => {
    // Write sample orchestrator log containing a secret token that must be redacted
    const sampleLog = path.join(logsDir, 'orchestrator.log');
    fs.writeFileSync(
      sampleLog,
      JSON.stringify({ msg: 'sync', auth: `Bearer ghp_${'a'.repeat(36)}`, aws: FAKE_AWS_KEY }) + '\n',
    );

    const archive = await diagnosticsService.exportArchive();

    expect(archive).toBeDefined();
    expect(archive.version).toBe('0.1.0');
    expect(archive.diagnostics.platform).toBeDefined();
    expect(archive.diagnostics.projects).toHaveLength(1);

    // Verify secret scan on the entire serialized output
    const serialized = JSON.stringify(archive);
    const hits = scanText(serialized, 'diagnostics.json');

    expect(hits).toHaveLength(0);
    expect(serialized).not.toContain(FAKE_AWS_KEY);
    expect(serialized).not.toContain('ghp_');
  });

  test('maintenance routes: /maintenance/prune and /diagnostics/export respond correctly', async () => {
    const PORT = 4099;
    const app = createApiServer({ token: 'test-token', getPort: () => PORT });
    registerMaintenanceRoutes(app, { retention: retentionService, diagnostics: diagnosticsService });
    await app.ready();

    const pruneRes = await app.inject({
      method: 'POST',
      url: '/maintenance/prune',
      headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer test-token' },
      payload: { maxAgeDays: 30 },
    });
    expect(pruneRes.statusCode).toBe(200);
    const pruneJson = JSON.parse(pruneRes.body);
    expect(pruneJson.ok).toBe(true);

    const diagRes = await app.inject({
      method: 'GET',
      url: '/diagnostics/export',
      headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer test-token' },
    });
    expect(diagRes.statusCode).toBe(200);
    const diagJson = JSON.parse(diagRes.body);
    expect(diagJson.version).toBe('0.1.0');
    expect(diagJson.diagnostics).toBeDefined();

    await app.close();
  });
});
