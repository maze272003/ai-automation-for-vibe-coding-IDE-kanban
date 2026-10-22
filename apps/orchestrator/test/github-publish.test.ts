// apps/orchestrator/test/github-publish.test.ts
import {
  githubConnections,
  mergeApprovals,
  projects,
  pullRequests,
  remoteSyncRuns,
  repositoryConnections,
  userStories,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubPublishService, type GitHubPullsApi } from '../src/github/publish-service.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

describe('GitHubPublishService (GH-7)', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let authService: GitHubAuthService;
  let credentialStore: MemoryCredentialStore;
  let repoConnId: number;

  beforeAll(async () => {
    dbHolder = createTestDb();
    credentialStore = new MemoryCredentialStore();

    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
    });

    const now = new Date();
    await credentialStore.saveTokens(12345, {
      accessToken: 'gho_publish_token',
      refreshToken: 'ghr_publish_refresh',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: now.getTime(),
      expiresIn: 3600,
      refreshTokenExpiresIn: 100000,
    });

    const conn = dbHolder.db
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
      .returning()
      .get();

    const repoConn = dbHolder.db
      .insert(repositoryConnections)
      .values({
        githubConnectionId: conn.id,
        githubRepoId: 54321,
        owner: 'octocat',
        name: 'hello-world',
        defaultBranch: 'main',
        visibility: 'public',
      })
      .returning()
      .get();
    repoConnId = repoConn.id;
  });

  it('refuses to publish when publish=false in settings (AC-4)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Publish Off Project',
        key: 'PUB0',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: false, // OFF!
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
        key: 'PUB0-1',
        title: 'Publish Off',
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

    const service = new GitHubPublishService({
      db: dbHolder.db,
      authService,
    });

    const res = await service.publishStory(story.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('publish setting is off');
  });

  it('refuses to publish without approve_publish approval row (AC-1)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'No Approval Project',
        key: 'NOAP',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
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

    const candidateSha = 'c'.repeat(40);
    const story = dbHolder.db
      .insert(userStories)
      .values({
        projectId: project.id,
        key: 'NOAP-1',
        title: 'No Approval Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: 'd'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const service = new GitHubPublishService({
      db: dbHolder.db,
      authService,
    });

    const res = await service.publishStory(story.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No publish approval found');
  });

  it('publishes PR using evidence from DB and creates PR record (AC-1, AC-2)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    // Create candidate commit
    fs.writeFileSync(path.join(repoPath, 'login.ts'), 'export const login = () => true;\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feat(PUB-1): login logic'], { cwd: repoPath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Publish Project',
        key: 'PUB1',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
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
        key: 'PUB1-1',
        title: 'Add Login Logic',
        description: 'Implements login and logout flow',
        priority: 'P1',
        rank: 1,
        revision: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoPath, encoding: 'utf8' }).trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Record human publish approval
    dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId: story.id,
        kind: 'publish',
        commitSha: candidateSha,
        approver: 'local-user',
        approvedAt: now,
      })
      .run();

    let createdPayload: { title?: string; head?: string; base?: string; body?: string } | null = null;
    let pushedBranch: string = '';

    const mockPullsApi: GitHubPullsApi = {
      createPull: async (_owner, _repo, data, _token) => {
        createdPayload = data;
        return {
          number: 101,
          html_url: 'https://github.com/octocat/hello-world/pull/101',
          state: 'open',
        };
      },
      updatePull: async () => ({ number: 101, html_url: 'url', state: 'open' }),
    };

    const service = new GitHubPublishService({
      db: dbHolder.db,
      authService,
      pullsApi: mockPullsApi,
      gitPushRunner: async (_repoPath, branchName, _sha, _token) => {
        pushedBranch = branchName;
      },
    });

    const res = await service.publishStory(story.id);

    expect(res.ok).toBe(true);
    expect(res.pullRequest?.number).toBe(101);
    expect(res.pullRequest?.url).toBe('https://github.com/octocat/hello-world/pull/101');
    expect(pushedBranch).toContain('PUB1-1');

    // Verify PR body generated from DB evidence (AC-2)
    expect(createdPayload!.title).toBe('PUB1-1: Add Login Logic');
    expect(createdPayload!.body).toContain('## Story: PUB1-1 — Add Login Logic');
    expect(createdPayload!.body).toContain('Implements login and logout flow');
    expect(createdPayload!.body).toContain('*Generated by AI Kanban (Attempt 0)*');

    // Verify pull_requests record in DB
    const prRow = dbHolder.db.select().from(pullRequests).where(eq(pullRequests.storyId, story.id)).get();
    expect(prRow).toBeDefined();
    expect(prRow?.number).toBe(101);
    expect(prRow?.headSha).toBe(candidateSha);

    // Verify remote_sync_runs audit log
    const syncRuns = dbHolder.db
      .select()
      .from(remoteSyncRuns)
      .where(eq(remoteSyncRuns.projectId, project.id))
      .all();
    expect(syncRuns.some((r) => r.kind === 'push' && r.status === 'succeeded')).toBe(true);
    expect(syncRuns.some((r) => r.kind === 'pr_create' && r.status === 'succeeded')).toBe(true);
  });

  it('handles force-with-lease rejection without overwriting (AC-3)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();
    const candidateSha = 'e'.repeat(40);

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Lease Project',
        key: 'LEAS',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
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
        key: 'LEAS-1',
        title: 'Lease Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        branchName: 'ai/LEAS-1-feature',
        candidateSha,
        candidateTree: 'f'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId: story.id,
        kind: 'publish',
        commitSha: candidateSha,
        approver: 'local-user',
        approvedAt: now,
      })
      .run();

    // Existing PR with an older headSha
    dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 202,
        url: 'https://github.com/octocat/hello-world/pull/202',
        headBranch: 'ai/LEAS-1-feature',
        headSha: '0'.repeat(40),
        baseBranch: 'main',
        state: 'open',
      })
      .run();

    const service = new GitHubPublishService({
      db: dbHolder.db,
      authService,
      gitPushRunner: async () => {
        throw new Error('fatal: [remote rejected] (stale info: force-with-lease failed)');
      },
    });

    const res = await service.publishStory(story.id);

    expect(res.ok).toBe(false);
    expect(res.forceWithLeaseFailed).toBe(true);
    expect(res.error).toContain('force-with-lease prevented overwrite');
  });
});
