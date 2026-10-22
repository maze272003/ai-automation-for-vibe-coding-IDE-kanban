// apps/orchestrator/src/github/pr-poller.ts
import {
  ProjectSettings,
  type ChecksSummary,
  type ReviewsSummary,
  type GitHubCheckItem,
  type GitHubReviewItem,
} from '@aik/contracts';
import {
  mergeApprovals,
  projects,
  pullRequests,
  remoteSyncRuns,
  repositoryConnections,
  userStories,
  type AikDb,
} from '@aik/db';
import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import type { EventBus } from '../events/bus.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { GitHubAuthService } from './service.ts';

export interface RawGitHubPullData {
  head?: { sha?: string };
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  merged_by?: { login?: string } | null;
}

export interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  started_at?: string;
}

export interface RawStatusItem {
  context: string;
  state: string;
  target_url?: string;
  description?: string;
}

export interface RawCombinedStatus {
  state: string;
  total_count: number;
  statuses: RawStatusItem[];
}

export interface RawReview {
  id?: number;
  user?: { login?: string } | null;
  state: string;
  body?: string | null;
  submitted_at?: string;
}

export interface GitHubPollerApi {
  getPull: (
    owner: string,
    repo: string,
    number: number,
    etag: string | null,
    token: string,
  ) => Promise<{ status: 200 | 304; data?: RawGitHubPullData; etag?: string }>;
  getCheckRuns: (
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ) => Promise<RawCheckRun[]>;
  getCombinedStatus: (
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ) => Promise<RawCombinedStatus | null>;
  getReviews: (
    owner: string,
    repo: string,
    number: number,
    token: string,
  ) => Promise<RawReview[]>;
}

export interface GitHubPRPollerDeps {
  db: AikDb;
  authService: GitHubAuthService;
  workflow: WorkflowService;
  bus: EventBus;
  now?: Clock;
  redact?: (text: string) => string;
  api?: GitHubPollerApi;
}

export interface PollResult {
  ok: boolean;
  notModified?: boolean;
  headDrifted?: boolean;
  checksSummary?: ChecksSummary;
  reviewsSummary?: ReviewsSummary;
  state?: 'open' | 'closed' | 'merged';
  error?: string;
}

export class GitHubPRPoller {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly api?: GitHubPollerApi;

  constructor(deps: GitHubPRPollerDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.api = deps.api;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async pollPullRequest(prId: number): Promise<PollResult> {
    const startedAt = this.nowDate();
    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
    if (!pr) return { ok: false, error: `Pull request ${prId} not found` };

    const repoConn = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, pr.repositoryConnectionId))
      .get();
    if (!repoConn) return { ok: false, error: 'Repository connection not found' };

    const story = this.db.select().from(userStories).where(eq(userStories.id, pr.storyId)).get();
    if (!story) return { ok: false, error: `Story for PR ${pr.number} not found` };

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: 'Project not found' };

    const auth = await this.authService.getValidAccessToken();
    if (!auth) return { ok: false, error: 'GitHub authentication expired or unavailable' };

    const token = auth.token;
    const owner = repoConn.owner;
    const repo = repoConn.name;

    try {
      // 1. Fetch Pull Request with ETag support
      let prStatus = 200;
      let prData: RawGitHubPullData | null = null;
      let newEtag = pr.etag ?? undefined;

      if (this.api) {
        const res = await this.api.getPull(owner, repo, pr.number, pr.etag, token);
        prStatus = res.status;
        prData = res.data ?? null;
        newEtag = res.etag ?? newEtag;
      } else {
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'AI-Kanban',
        };
        if (pr.etag) {
          headers['if-none-match'] = pr.etag;
        }
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`, { headers });
        prStatus = res.status;
        if (res.status === 200) {
          prData = (await res.json()) as RawGitHubPullData;
          newEtag = res.headers.get('etag') ?? undefined;
        } else if (res.status !== 304) {
          throw new Error(`GitHub pulls API error ${res.status}: ${await res.text()}`);
        }
      }

      // AC-1: 304 responses don't change state
      if (prStatus === 304) {
        this.db
          .update(pullRequests)
          .set({ lastPolledAt: this.nowDate() })
          .where(eq(pullRequests.id, pr.id))
          .run();

        this.db.insert(remoteSyncRuns).values({
          projectId: project.id,
          kind: 'pr_poll',
          status: 'succeeded',
          detail: `PR #${pr.number} not modified (304)`,
          startedAt,
          endedAt: this.nowDate(),
        }).run();

        return { ok: true, notModified: true };
      }

      const remoteHeadSha = (prData?.head?.sha ?? pr.headSha) as string;
      const remoteState = (prData?.merged ? 'merged' : prData?.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed' | 'merged';
      const mergeCommitSha = prData?.merge_commit_sha ?? null;

      // 2. Fetch Check Runs & Combined Status
      let rawChecks: RawCheckRun[] = [];
      let rawStatus: RawCombinedStatus | null = null;

      if (this.api) {
        rawChecks = await this.api.getCheckRuns(owner, repo, remoteHeadSha, token);
        rawStatus = await this.api.getCombinedStatus(owner, repo, remoteHeadSha, token);
      } else {
        const checkRunsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${remoteHeadSha}/check-runs?filter=latest`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'AI-Kanban',
            },
          },
        );
        if (checkRunsRes.ok) {
          const checksJson = (await checkRunsRes.json()) as { check_runs?: RawCheckRun[] };
          rawChecks = checksJson.check_runs ?? [];
        }

        const statusRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${remoteHeadSha}/status`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'AI-Kanban',
            },
          },
        );
        if (statusRes.ok) {
          rawStatus = (await statusRes.json()) as RawCombinedStatus;
        }
      }

      // Aggregate ChecksSummary
      const checksItems: GitHubCheckItem[] = [];
      let passedCount = 0;
      let failedCount = 0;
      let pendingCount = 0;

      for (const cr of rawChecks) {
        const conclusion = cr.conclusion ?? null;
        const status = cr.status ?? 'completed';
        checksItems.push({
          name: cr.name ?? 'check-run',
          status,
          conclusion,
          url: cr.html_url ?? null,
        });

        if (status === 'queued' || status === 'in_progress') {
          pendingCount++;
        } else if (conclusion === 'success' || conclusion === 'neutral') {
          passedCount++;
        } else {
          failedCount++;
        }
      }

      if (rawStatus && Array.isArray(rawStatus.statuses)) {
        for (const st of rawStatus.statuses) {
          const state = st.state; // 'success' | 'failure' | 'error' | 'pending'
          checksItems.push({
            name: st.context ?? 'commit-status',
            status: state,
            conclusion: state === 'success' ? 'success' : state === 'pending' ? null : 'failure',
            url: st.target_url ?? null,
          });

          if (state === 'pending') pendingCount++;
          else if (state === 'success') passedCount++;
          else failedCount++;
        }
      }

      const totalChecks = passedCount + failedCount + pendingCount;
      const checksConclusion: ChecksSummary['conclusion'] =
        totalChecks === 0 ? 'none' : failedCount > 0 ? 'failure' : pendingCount > 0 ? 'pending' : 'success';

      const checksSummary: ChecksSummary = {
        total: totalChecks,
        passed: passedCount,
        failed: failedCount,
        pending: pendingCount,
        conclusion: checksConclusion,
        checks: checksItems,
      };

      // 3. Fetch GitHub Reviews
      let rawReviews: RawReview[] = [];
      if (this.api) {
        rawReviews = await this.api.getReviews(owner, repo, pr.number, token);
      } else {
        const revRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'AI-Kanban',
            },
          },
        );
        if (revRes.ok) {
          rawReviews = (await revRes.json()) as RawReview[];
        }
      }

      // Aggregate ReviewsSummary by latest state per user
      const latestByUser = new Map<string, { state: string; body?: string; submittedAt?: string }>();
      for (const r of rawReviews) {
        const login = r.user?.login;
        if (login) {
          latestByUser.set(login, {
            state: r.state,
            body: r.body ?? undefined,
            submittedAt: r.submitted_at ?? undefined,
          });
        }
      }

      let approved = 0;
      let changesRequested = 0;
      let commented = 0;
      const reviewList: GitHubReviewItem[] = [];

      for (const [user, rev] of latestByUser.entries()) {
        reviewList.push({
          user,
          state: rev.state,
          body: rev.body,
          submittedAt: rev.submittedAt,
        });
        if (rev.state === 'APPROVED') approved++;
        else if (rev.state === 'CHANGES_REQUESTED') changesRequested++;
        else if (rev.state === 'COMMENTED') commented++;
      }

      let reviewOverallState: ReviewsSummary['state'] = 'NONE';
      if (changesRequested > 0) reviewOverallState = 'CHANGES_REQUESTED';
      else if (approved > 0) reviewOverallState = 'APPROVED';
      else if (commented > 0) reviewOverallState = 'COMMENTED';

      const reviewsSummary: ReviewsSummary = {
        approved,
        changesRequested,
        commented,
        state: reviewOverallState,
        reviews: reviewList,
      };

      // Update pull_requests table
      this.db
        .update(pullRequests)
        .set({
          headSha: remoteHeadSha,
          state: remoteState,
          checksSummary,
          reviewsSummary,
          mergeCommitSha,
          etag: newEtag,
          lastPolledAt: this.nowDate(),
        })
        .where(eq(pullRequests.id, pr.id))
        .run();

      // AC-2: Head drift detection (E8 remote variant)
      let headDrifted = false;
      if (story.status === 'AWAITING_MERGE' && remoteHeadSha !== story.candidateSha) {
        headDrifted = true;
        // Determine newTree for the drifted remote commit
        let newTree = story.candidateTree ?? '';
        try {
          newTree = execFileSync('git', ['rev-parse', `${remoteHeadSha}^{tree}`], {
            cwd: project.repoPath,
            encoding: 'utf8',
          }).trim();
        } catch {
          // If commit not fetched locally yet, keep current candidateTree or fallback
        }

        this.workflow.transition({
          storyId: story.id,
          event: {
            type: 'candidate_head_changed',
            newSha: remoteHeadSha,
            newTree,
          },
          actor: 'system',
        });
        this.bus.notify(1);
      }

      this.db.insert(remoteSyncRuns).values({
        projectId: project.id,
        kind: 'pr_poll',
        status: 'succeeded',
        shaAfter: remoteHeadSha,
        detail: `Polled PR #${pr.number}: state=${remoteState}, checks=${checksConclusion}, reviews=${reviewOverallState}, headDrift=${headDrifted}`,
        startedAt,
        endedAt: this.nowDate(),
      }).run();

      return {
        ok: true,
        headDrifted,
        checksSummary,
        reviewsSummary,
        state: remoteState,
      };
    } catch (err) {
      const errorMsg = String(err);
      this.db.insert(remoteSyncRuns).values({
        projectId: project.id,
        kind: 'pr_poll',
        status: 'failed',
        detail: this.redact(errorMsg),
        startedAt,
        endedAt: this.nowDate(),
      }).run();
      return { ok: false, error: `Failed to poll PR #${pr.number}: ${this.redact(errorMsg)}` };
    }
  }

  /** Checks if merging this PR is currently permitted by remote gates. */
  isMergeAllowed(prId: number): { allowed: boolean; reason?: string } {
    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
    if (!pr) return { allowed: false, reason: 'PR record not found' };

    const story = this.db.select().from(userStories).where(eq(userStories.id, pr.storyId)).get();
    if (!story) return { allowed: false, reason: 'Story not found' };

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { allowed: false, reason: 'Project not found' };

    const settings = ProjectSettings.parse(project.settings);

    // Check remote checks gate (AC-3)
    if (settings.requireRemoteChecks && pr.checksSummary) {
      if (pr.checksSummary.conclusion === 'failure') {
        return { allowed: false, reason: 'One or more required GitHub checks failed' };
      }
      if (pr.checksSummary.conclusion === 'pending') {
        return { allowed: false, reason: 'GitHub checks are still running' };
      }
    }

    // Check remote reviews gate
    if (pr.reviewsSummary && pr.reviewsSummary.state === 'CHANGES_REQUESTED') {
      // Check for human override in merge_approvals (AC-4)
      const override = this.db
        .select()
        .from(mergeApprovals)
        .where(
          and(
            eq(mergeApprovals.storyId, story.id),
            eq(mergeApprovals.kind, 'override_remote_review'),
            eq(mergeApprovals.commitSha, pr.headSha),
          ),
        )
        .get();

      if (!override) {
        return {
          allowed: false,
          reason: 'A GitHub reviewer requested changes; resolve via rework or human override',
        };
      }
    }

    return { allowed: true };
  }

  /** Records a human override for a remote review CHANGES_REQUESTED verdict (AC-4). */
  async overrideRemoteReview(storyId: number, note: string): Promise<{ ok: boolean; error?: string }> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story) return { ok: false, error: `Story ${storyId} not found` };
    if (!story.candidateSha) return { ok: false, error: 'Story has no candidateSha' };

    this.db
      .insert(mergeApprovals)
      .values({
        storyId,
        kind: 'override_remote_review',
        commitSha: story.candidateSha,
        approver: 'local-user',
        note,
        approvedAt: this.nowDate(),
      })
      .onConflictDoNothing()
      .run();

    return { ok: true };
  }
}
