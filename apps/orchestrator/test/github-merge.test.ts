// apps/orchestrator/test/github-merge.test.ts
import {
  githubConnections,
  mergeApprovals,
  merges,
  projects,
  pullRequests,
  repositoryConnections,
  userStories,
  verificationChecks,
  verificationRuns,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubMergeService, type GitHubMergeApi } from '../src/github/merge-service.ts';
import { GitHubPRPoller } from '../src/github/pr-poller.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import type { VerificationRunner } from '../src/verify/runner.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

describe('GitHubMergeService (GH-9)', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let authService: GitHubAuthService;
  let credentialStore: MemoryCredentialStore;
  let repoConnId: number;
  let poller: GitHubPRPoller;

  beforeAll(async () => {
    dbHolder = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: dbHolder.db, bus });
    credentialStore = new MemoryCredentialStore();

    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
    });

    poller = new GitHubPRPoller({
      db: dbHolder.db,
      authService,
      workflow,
      bus,
    });

    const now = new Date();
    await credentialStore.saveTokens(12345, {
      accessToken: 'gho_merge_token',
      refreshToken: 'ghr_merge_refresh',
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
        githubRepoId: 11223,
        owner: 'octocat',
        name: 'merge-repo',
        defaultBranch: 'main',
        visibility: 'public',
      })
      .returning()
      .get();
    repoConnId = repoConn.id;
  });

  it('merges PR with exact approved SHA, verifies post-merge checks, and transitions to DONE (AC-1, AC-4)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    // Create candidate commit
    fs.writeFileSync(path.join(repoPath, 'merged.ts'), 'export const val = 42;\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feat(MRG-1): candidate commit'], { cwd: repoPath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // Merged commit containing candidate
    fs.writeFileSync(path.join(repoPath, 'post.ts'), 'export const post = true;\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'Merge PR #10'], { cwd: repoPath });
    const remoteMergedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Merge Project',
        key: 'MRG1',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: true, // Enabled!
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
        key: 'MRG1-1',
        title: 'Merge Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoPath, encoding: 'utf8' }).trim(),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Merge approval for candidate
    dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId: story.id,
        kind: 'merge',
        commitSha: candidateSha,
        approver: 'local-user',
        approvedAt: now,
      })
      .run();

    // Pull request record
    dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 10,
        url: 'https://github.com/octocat/merge-repo/pull/10',
        headBranch: 'ai/MRG1-1',
        headSha: candidateSha,
        baseBranch: 'main',
        state: 'open',
      })
      .returning()
      .get();

    let passedShaToMergeApi = '';
    const mockMergeApi: GitHubMergeApi = {
      mergePull: async (_owner, _repo, _number, data, _token) => {
        passedShaToMergeApi = data.sha;
        return {
          status: 200,
          data: {
            sha: remoteMergedSha,
            merged: true,
            message: 'Pull Request successfully merged',
          },
        };
      },
    };

    let postMergeVerified = false;
    const mockVerification: Partial<VerificationRunner> = {
      verifyPostMerge: async (input) => {
        if (input.mergedSha === remoteMergedSha) {
          postMergeVerified = true;
          const vRun = dbHolder.db
            .insert(verificationRuns)
            .values({
              storyId: input.storyId,
              commitSha: input.mergedSha,
              trigger: 'postmerge',
              status: 'passed',
              startedAt: now,
              endedAt: now,
            })
            .returning()
            .get();

          dbHolder.db
            .insert(verificationChecks)
            .values({
              verificationRunId: vRun.id,
              checkKey: 'test',
              mandatory: true,
              command: 'npm test',
              cwd: repoPath,
              status: 'passed',
              exitCode: 0,
              startedAt: now,
              endedAt: now,
            })
            .run();

          return { ok: true, status: 'passed', verificationRunId: vRun.id };
        }
        return { ok: false, status: 'failed', error: 'Wrong SHA for post-merge' };
      },
    };

    const mergeService = new GitHubMergeService({
      db: dbHolder.db,
      authService,
      poller,
      workflow,
      bus,
      verification: mockVerification as VerificationRunner,
      mergeApi: mockMergeApi,
      gitFetchRunner: async () => remoteMergedSha,
    });

    const res = await mergeService.mergeStory(story.id);

    expect(res.ok).toBe(true);
    expect(res.mergedSha).toBe(remoteMergedSha);
    expect(passedShaToMergeApi).toBe(candidateSha); // AC-1: exact approved SHA
    expect(postMergeVerified).toBe(true); // AC-4: verified post-merge

    // Story reached DONE (T10)
    const updatedStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(updatedStory?.status).toBe('DONE');
    expect(updatedStory?.mergedSha).toBe(remoteMergedSha);

    // Merges table audit
    const mergeRows = dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all();
    expect(mergeRows).toHaveLength(1);
    expect(mergeRows[0]!.status).toBe('succeeded');
    expect(mergeRows[0]!.mergedSha).toBe(remoteMergedSha);
  });

  it('handles 409 Conflict without recording success, triggering reverification (AC-2)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();
    const candidateSha = 'a'.repeat(40);

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: '409 Project',
        key: 'C409',
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
        key: 'C409-1',
        title: 'Conflict 409 Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: 'b'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId: story.id,
        kind: 'merge',
        commitSha: candidateSha,
        approver: 'local-user',
        approvedAt: now,
      })
      .run();

    dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 409,
        url: 'https://github.com/octocat/merge-repo/pull/409',
        headBranch: 'ai/C409-1',
        headSha: candidateSha,
        baseBranch: 'main',
        state: 'open',
      })
      .run();

    const mockMergeApi: GitHubMergeApi = {
      mergePull: async () => ({
        status: 409,
        error: 'Head branch changed or was modified',
      }),
    };

    const mergeService = new GitHubMergeService({
      db: dbHolder.db,
      authService,
      poller,
      workflow,
      bus,
      verification: {} as VerificationRunner,
      mergeApi: mockMergeApi,
    });

    const res = await mergeService.mergeStory(story.id);

    expect(res.ok).toBe(false);
    expect(res.reverificationRequired).toBe(true);

    // Merge record marked failed, not succeeded
    const mergeRows = dbHolder.db.select().from(merges).where(eq(merges.storyId, story.id)).all();
    expect(mergeRows).toHaveLength(1);
    expect(mergeRows[0]!.status).toBe('failed');
  });

  it('handles 405 Method Not Allowed and story stays AWAITING_MERGE (AC-3)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();
    const candidateSha = 'd'.repeat(40);

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: '405 Project',
        key: 'C405',
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
        key: 'C405-1',
        title: 'Not Allowed 405 Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: 'e'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    dbHolder.db
      .insert(mergeApprovals)
      .values({
        storyId: story.id,
        kind: 'merge',
        commitSha: candidateSha,
        approver: 'local-user',
        approvedAt: now,
      })
      .run();

    dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 405,
        url: 'https://github.com/octocat/merge-repo/pull/405',
        headBranch: 'ai/C405-1',
        headSha: candidateSha,
        baseBranch: 'main',
        state: 'open',
      })
      .run();

    const mockMergeApi: GitHubMergeApi = {
      mergePull: async () => ({
        status: 405,
        error: 'Pull Request is not mergeable',
      }),
    };

    const mergeService = new GitHubMergeService({
      db: dbHolder.db,
      authService,
      poller,
      workflow,
      bus,
      verification: {} as VerificationRunner,
      mergeApi: mockMergeApi,
    });

    const res = await mergeService.mergeStory(story.id);

    expect(res.ok).toBe(false);
    expect(res.status405).toBe(true);
    expect(res.error).toContain('Pull Request is not mergeable');

    // Story stays in AWAITING_MERGE
    const currentStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(currentStory?.status).toBe('AWAITING_MERGE');
  });

  it('rejects external merge if commit does not contain candidate, moving to BLOCKED (AC-5)', async () => {
    const repoPath = makeTempRepo();
    const now = new Date();

    // Commit 1: candidate
    fs.writeFileSync(path.join(repoPath, 'cand.ts'), 'cand\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'candidate'], { cwd: repoPath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    // Commit 2 on completely separate branch: external commit that does not contain candidate
    execFileSync('git', ['checkout', '--orphan', 'unrelated'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'unrelated\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'unrelated external merge'], { cwd: repoPath });
    const externalCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

    const project = dbHolder.db
      .insert(projects)
      .values({
        name: 'Ext Project',
        key: 'EXT1',
        repoPath,
        baseBranch: 'main',
        repositoryConnectionId: repoConnId,
        settings: {
          checks: [],
          shellAllowlist: [],
          protectedPaths: [],
          secretsOnlyVerification: false,
          publish: true,
          remoteMerge: false, // Local/external mode
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
        key: 'EXT1-1',
        title: 'External Merge Story',
        priority: 'P2',
        rank: 1,
        status: 'AWAITING_MERGE',
        statusVersion: 1,
        candidateSha,
        candidateTree: 'z'.repeat(40),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    dbHolder.db
      .insert(pullRequests)
      .values({
        storyId: story.id,
        repositoryConnectionId: repoConnId,
        number: 777,
        url: 'https://github.com/octocat/merge-repo/pull/777',
        headBranch: 'ai/EXT1-1',
        headSha: candidateSha,
        baseBranch: 'main',
        state: 'merged',
        mergeCommitSha: externalCommitSha, // Does NOT contain candidate!
      })
      .run();

    const mergeService = new GitHubMergeService({
      db: dbHolder.db,
      authService,
      poller,
      workflow,
      bus,
      verification: {} as VerificationRunner,
    });

    const res = await mergeService.handleExternalMerge(story.id);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('does not contain approved candidate');

    // Story transitioned to BLOCKED(environment) per AC-5
    const currentStory = dbHolder.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    expect(currentStory?.status).toBe('BLOCKED');
    expect(currentStory?.blockedReason).toBe('environment');
  });
});
