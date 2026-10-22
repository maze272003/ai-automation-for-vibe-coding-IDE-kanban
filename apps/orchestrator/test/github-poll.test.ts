// apps/orchestrator/test/github-poll.test.ts
import {
  githubConnections,
  mergeApprovals,
  projects,
  pullRequests,
  repositoryConnections,
  userStories,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubPRPoller, type GitHubPollerApi } from '../src/github/pr-poller.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

describe('GitHubPRPoller (GH-8)', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let authService: GitHubAuthService;
  let credentialStore: MemoryCredentialStore;
  let repoConnId: number;

  beforeAll(async () => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    credentialStore = new MemoryCredentialStore();

    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
    });

    const now = new Date();
    await credentialStore.saveTokens(12345, {
      accessToken: 'gho_poll_token',
      refreshToken: 'ghr_poll_refresh',
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
        githubRepoId: 98765,
        owner: 'octocat',
        name: 'poller-repo',
        defaultBranch: 'main',
        visibility: 'public',
      })
      .returning()
      .get();
    repoConnId = repoConn.id;
  });

  it('handles 304 Not Modified without changing state (AC-1)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'ETag Project',
        key: 'ETAG',
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
        key: 'ETAG-1',
        title: 'ETag Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha: '1'.repeat(40),
        candidateTree: '2'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const pr = dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 42,
        url: 'https://github.com/octocat/poller-repo/pull/42',
        headBranch: 'ai/ETAG-1',
        headSha: '1'.repeat(40),
        baseBranch: 'main',
        state: 'open',
        etag: '"test-etag-123"',
        lastPolledAt: now,
      })
      .returning()
      .get();

    const mockApi: GitHubPollerApi = {
      getPull: async () => ({ status: 304 }),
      getCheckRuns: async () => [],
      getCombinedStatus: async () => null,
      getReviews: async () => [],
    };

    const poller = new GitHubPRPoller({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      api: mockApi,
    });

    const res = await poller.pollPullRequest(pr.id);
    expect(res.ok).toBe(true);
    expect(res.notModified).toBe(true);

    // Verify story state untouched
    const currentStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(currentStory?.status).toBe('AWAITING_MERGE');
  });

  it('detects head drift and moves story from AWAITING_MERGE to TESTING (AC-2)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();
    const localCandidateSha = 'a'.repeat(40);
    const remoteDriftedSha = 'b'.repeat(40);

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Drift Project',
        key: 'DRIF',
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
        key: 'DRIF-1',
        title: 'Drift Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha: localCandidateSha,
        candidateTree: 't'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const pr = dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 55,
        url: 'https://github.com/octocat/poller-repo/pull/55',
        headBranch: 'ai/DRIF-1',
        headSha: localCandidateSha,
        baseBranch: 'main',
        state: 'open',
      })
      .returning()
      .get();

    const mockApi: GitHubPollerApi = {
      getPull: async () => ({
        status: 200,
        data: {
          head: { sha: remoteDriftedSha },
          state: 'open',
          merged: false,
        },
        etag: '"new-etag-456"',
      }),
      getCheckRuns: async () => [],
      getCombinedStatus: async () => null,
      getReviews: async () => [],
    };

    const poller = new GitHubPRPoller({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      api: mockApi,
    });

    const res = await poller.pollPullRequest(pr.id);
    expect(res.ok).toBe(true);
    expect(res.headDrifted).toBe(true);

    // Story returned to TESTING via T11
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('TESTING');
    expect(updatedStory?.candidateSha).toBe(remoteDriftedSha);

    // PR headSha updated
    const updatedPr = dbHolder.db.select().from(pullRequests).where(eq(pullRequests.id, pr.id)).get();
    expect(updatedPr?.headSha).toBe(remoteDriftedSha);
  });

  it('aggregates checks, disables merge on check failure, and supports review override (AC-3, AC-4)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();
    const candidateSha = 'c'.repeat(40);

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Checks Project',
        key: 'CHKS',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: true,
          requireRemoteChecks: true, // Gate enabled!
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
        key: 'CHKS-1',
        title: 'Checks Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: 't'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const pr = dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 88,
        url: 'https://github.com/octocat/poller-repo/pull/88',
        headBranch: 'ai/CHKS-1',
        headSha: candidateSha,
        baseBranch: 'main',
        state: 'open',
      })
      .returning()
      .get();

    // 1. Mock failing check run + CHANGES_REQUESTED review
    const mockApi: GitHubPollerApi = {
      getPull: async () => ({
        status: 200,
        data: { head: { sha: candidateSha }, state: 'open', merged: false },
      }),
      getCheckRuns: async () => [
        { name: 'ci/test', status: 'completed', conclusion: 'failure', html_url: 'http://ci/1' },
      ],
      getCombinedStatus: async () => null,
      getReviews: async () => [
        { user: { login: 'senior-dev' }, state: 'CHANGES_REQUESTED', body: 'Please fix CI' },
      ],
    };

    const poller = new GitHubPRPoller({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
      api: mockApi,
    });

    const res = await poller.pollPullRequest(pr.id);
    expect(res.ok).toBe(true);
    expect(res.checksSummary?.conclusion).toBe('failure');
    expect(res.reviewsSummary?.state).toBe('CHANGES_REQUESTED');

    // Merge gate should deny merge due to failing checks (AC-3)
    let mergeGate = poller.isMergeAllowed(pr.id);
    expect(mergeGate.allowed).toBe(false);
    expect(mergeGate.reason).toContain('required GitHub checks failed');

    // 2. Now simulated: checks pass, but CHANGES_REQUESTED is still present
    mockApi.getCheckRuns = async () => [
      { name: 'ci/test', status: 'completed', conclusion: 'success', html_url: 'http://ci/1' },
    ];
    await poller.pollPullRequest(pr.id);

    mergeGate = poller.isMergeAllowed(pr.id);
    expect(mergeGate.allowed).toBe(false);
    expect(mergeGate.reason).toContain('requested changes');

    // 3. Human overrides remote review (AC-4)
    await poller.overrideRemoteReview(story.id, 'Reviewed and verified safe by team lead');

    // Check merge_approvals row
    const overrideRow = dbHolder.db
      .select()
      .from(mergeApprovals)
      .where(eq(mergeApprovals.kind, 'override_remote_review'))
      .get();
    expect(overrideRow).toBeDefined();
    expect(overrideRow?.commitSha).toBe(candidateSha);

    // Merge gate should now allow merge
    mergeGate = poller.isMergeAllowed(pr.id);
    expect(mergeGate.allowed).toBe(true);
  });
});
