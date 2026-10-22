// apps/orchestrator/test/github-sync.test.ts
import {
  githubConnections,
  projects,
  remoteSyncRuns,
  repositoryConnections,
  userStories,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { GitHubSyncService } from '../src/github/sync-service.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

describe('GitHubSyncService (GH-6)', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let authService: GitHubAuthService;
  let credentialStore: MemoryCredentialStore;

  beforeAll(async () => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    credentialStore = new MemoryCredentialStore();

    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
    });

    // Seed active GitHub connection
    const now = new Date();
    await credentialStore.saveTokens(12345, {
      accessToken: 'gho_valid_test_token',
      refreshToken: 'ghr_refresh_token',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: now.getTime(),
      expiresIn: 3600,
      refreshTokenExpiresIn: 100000,
    });

    dbHolder.db
      .insert(githubConnections)
      .values({
        githubUserId: 12345,
        login: 'octocat',
        appClientId: 'Iv1.test_client_id',
        tokenRef: 'github_token_12345',
        status: 'connected',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  it('detects upstream base change and syncs cleanly returning story to TESTING (AC-1)', async () => {
    const repoPath = makeTempRepo();
    const branchName = 'ai/SYNC-1-add-feature';

    // 1. Base commit on main
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // 2. Candidate commit branched from base
    execFileSync('git', ['checkout', '-b', branchName], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature branch changes\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feat: candidate commit'], { cwd: repoPath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // 3. Main moved upstream with a non-conflicting change
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'other.txt'), 'independent main changes\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'chore: main moved'], { cwd: repoPath });
    const newMainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const now = new Date();
    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Sync Project',
        key: 'SYNC',
        repoPath,
        baseBranch: 'main',
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: false,
          requireRemoteChecks: true,
          autoAcceptPlans: false,
          maxAttempts: 3,
          allowPaid: false,
          allowMayTrain: false,
          webfetch: false,
          mergeMethod: 'merge',
          budgets: { requestsPerRun: 10, requestsPerStory: 20, inputTokensPerStory: 1000 },
          jobLimits: { memoryMb: 512, maxProcesses: 10 },
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const story = dbHolder.db
      .insert(userStories)
      .values({
        projectId: project.id,
        key: 'SYNC-1',
        title: 'Sync Feature',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        branchName,
        baseSha: baseCommit,
        candidateSha,
        candidateTree: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoPath, encoding: 'utf8' }).trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const syncService = new GitHubSyncService({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      gitFetchRunner: async () => newMainSha,
    });

    const result = await syncService.syncStoryWithBase(story.id);

    expect(result.ok).toBe(true);
    expect(result.baseMoved).toBe(true);
    expect(result.syncedSha).toBeDefined();

    // Check story was transitioned to TESTING (T11)
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('TESTING');
    expect(updatedStory?.candidateSha).toBe(result.syncedSha);

    // Verify remote_sync_runs audit record
    const syncRuns = dbHolder.db
      .select()
      .from(remoteSyncRuns)
      .where(eq(remoteSyncRuns.projectId, project.id))
      .all();
    expect(syncRuns.length).toBeGreaterThanOrEqual(1);
    expect(syncRuns[0]!.kind).toBe('fetch');
    expect(syncRuns[0]!.status).toBe('succeeded');
  });

  it('detects merge conflict and transitions story to REWORK (AC-2)', async () => {
    const repoPath = makeTempRepo();
    const branchName = 'ai/SYNC-2-conflict';

    // 1. Initial file
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'line 1\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init shared'], { cwd: repoPath });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // 2. Candidate commit touches shared.txt
    execFileSync('git', ['checkout', '-b', branchName], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'candidate change\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'candidate change'], { cwd: repoPath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // 3. Upstream main also touches shared.txt with conflicting change
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'shared.txt'), 'upstream conflicting change\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'upstream change'], { cwd: repoPath });
    const upstreamSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const now = new Date();
    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Conflict Project',
        key: 'CONF',
        repoPath,
        baseBranch: 'main',
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: false,
          requireRemoteChecks: true,
          autoAcceptPlans: false,
          maxAttempts: 3,
          allowPaid: false,
          allowMayTrain: false,
          webfetch: false,
          mergeMethod: 'merge',
          budgets: { requestsPerRun: 10, requestsPerStory: 20, inputTokensPerStory: 1000 },
          jobLimits: { memoryMb: 512, maxProcesses: 10 },
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const story = dbHolder.db
      .insert(userStories)
      .values({
        projectId: project.id,
        key: 'CONF-1',
        title: 'Conflict Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        attemptCount: 1,
        maxAttempts: 3,
        branchName,
        baseSha: baseCommit,
        candidateSha,
        candidateTree: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoPath, encoding: 'utf8' }).trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const syncService = new GitHubSyncService({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      gitFetchRunner: async () => upstreamSha,
    });

    const result = await syncService.syncStoryWithBase(story.id);

    expect(result.ok).toBe(false);
    expect(result.baseMoved).toBe(true);
    expect(result.conflict).toBe(true);

    // Verify story transitioned to REWORK (T12)
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('REWORK');
  });

  it('handles fetch failure and transitions story to BLOCKED(auth) (AC-3)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    const repoConn = dbHolder.db
      .insert(repositoryConnections)
      .values({
        githubConnectionId: 1,
        githubRepoId: 99999,
        owner: 'octocat',
        name: 'fail-repo',
        defaultBranch: 'main',
        visibility: 'public',
      })
      .returning()
      .get();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Fail Project',
        key: 'FAIL',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConn.id,
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: false,
          requireRemoteChecks: true,
          autoAcceptPlans: false,
          maxAttempts: 3,
          allowPaid: false,
          allowMayTrain: false,
          webfetch: false,
          mergeMethod: 'merge',
          budgets: { requestsPerRun: 10, requestsPerStory: 20, inputTokensPerStory: 1000 },
          jobLimits: { memoryMb: 512, maxProcesses: 10 },
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const story = dbHolder.db
      .insert(userStories)
      .values({
        projectId: project.id,
        key: 'FAIL-1',
        title: 'Fail Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha: 'a'.repeat(40),
        candidateTree: 'b'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const syncService = new GitHubSyncService({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      gitFetchRunner: async () => {
        throw new Error('fatal: Authentication failed for token');
      },
    });

    const result = await syncService.syncStoryWithBase(story.id);

    expect(result.ok).toBe(false);
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('BLOCKED');
    expect(updatedStory?.blockedReason).toBe('auth');
  });
});
