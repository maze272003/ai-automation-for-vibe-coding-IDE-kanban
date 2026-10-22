// apps/orchestrator/src/github/merge-service.ts
import { ProjectSettings } from '@aik/contracts';
import {
  mergeApprovals,
  merges,
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
import { gitWithCredentials } from '../git/git.ts';
import { systemClock, type Clock } from '../time.ts';
import type { VerificationRunner } from '../verify/runner.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { GitHubPRPoller } from './pr-poller.ts';
import type { GitHubAuthService } from './service.ts';

export interface GitHubMergeApi {
  mergePull: (
    owner: string,
    repo: string,
    number: number,
    data: { sha: string; merge_method: 'merge' | 'squash'; commit_title?: string },
    token: string,
  ) => Promise<{ status: 200 | 405 | 409; data?: { sha: string; merged: boolean; message: string }; error?: string }>;
}

export interface GitHubMergeServiceDeps {
  db: AikDb;
  authService: GitHubAuthService;
  poller: GitHubPRPoller;
  workflow: WorkflowService;
  bus: EventBus;
  verification: VerificationRunner;
  now?: Clock;
  redact?: (text: string) => string;
  mergeApi?: GitHubMergeApi;
  gitFetchRunner?: (repoPath: string, baseBranch: string, token: string) => Promise<string>;
}

export interface RemoteMergeResult {
  ok: boolean;
  mergedSha?: string;
  reverificationRequired?: boolean;
  status405?: boolean;
  error?: string;
}

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

export class GitHubMergeService {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly poller: GitHubPRPoller;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly verification: VerificationRunner;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly mergeApi?: GitHubMergeApi;
  private readonly gitFetchRunner?: (repoPath: string, baseBranch: string, token: string) => Promise<string>;

  constructor(deps: GitHubMergeServiceDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.poller = deps.poller;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.verification = deps.verification;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.mergeApi = deps.mergeApi;
    this.gitFetchRunner = deps.gitFetchRunner;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async mergeStory(storyId: number, options?: { method?: 'merge' | 'squash'; approver?: string }): Promise<RemoteMergeResult> {
    const startedAt = this.nowDate();
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story) return { ok: false, error: `Story ${storyId} not found` };
    if (!story.candidateSha) return { ok: false, error: `Story ${story.key} lacks candidateSha` };
    if (story.status !== 'AWAITING_MERGE') {
      return { ok: false, error: `Story ${story.key} is not in AWAITING_MERGE (status: ${story.status})` };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: 'Project not found' };

    const settings = ProjectSettings.parse(project.settings);
    if (!settings.publish || !settings.remoteMerge) {
      return { ok: false, error: 'Remote merge is not enabled in project settings' };
    }

    const candidate = story.candidateSha;

    // AC-1: Verify human merge approval for the exact candidate SHA
    const approval = this.db
      .select()
      .from(mergeApprovals)
      .where(
        and(
          eq(mergeApprovals.storyId, story.id),
          eq(mergeApprovals.kind, 'merge'),
          eq(mergeApprovals.commitSha, candidate),
        ),
      )
      .get();
    if (!approval) {
      return { ok: false, error: `There is no human merge approval for candidate ${candidate}` };
    }

    // Look up PR
    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.storyId, story.id)).get();
    if (!pr) return { ok: false, error: `No pull request found for story ${story.key}` };

    const repoConn = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, pr.repositoryConnectionId))
      .get();
    if (!repoConn) return { ok: false, error: 'Repository connection not found' };

    // Check remote merge gates (checks & reviews)
    const gateCheck = this.poller.isMergeAllowed(pr.id);
    if (!gateCheck.allowed) {
      return { ok: false, error: `Merge gate failed: ${gateCheck.reason}` };
    }

    const auth = await this.authService.getValidAccessToken();
    if (!auth) return { ok: false, error: 'GitHub authentication expired or unavailable' };

    const mergeMethod = options?.method ?? settings.mergeMethod ?? 'merge';
    const methodEnum = mergeMethod === 'squash' ? 'github_squash' : 'github_merge';

    // Record running merge
    const mergeRow = this.db
      .insert(merges)
      .values({
        storyId: story.id,
        method: methodEnum,
        approvedSha: candidate,
        pullRequestId: pr.id,
        status: 'running',
        startedAt,
      })
      .returning()
      .get();

    // Call GitHub Merge API
    let apiStatus: number;
    let mergedSha: string | null = null;
    let errorMessage: string | null = null;

    try {
      if (this.mergeApi) {
        const res = await this.mergeApi.mergePull(repoConn.owner, repoConn.name, pr.number, {
          sha: candidate, // AC-1: carries exactly the approved SHA
          merge_method: mergeMethod,
        }, auth.token);
        apiStatus = res.status;
        mergedSha = res.data?.sha ?? null;
        errorMessage = res.error ?? res.data?.message ?? null;
      } else {
        const res = await fetch(`https://api.github.com/repos/${repoConn.owner}/${repoConn.name}/pulls/${pr.number}/merge`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${auth.token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'AI-Kanban',
          },
          body: JSON.stringify({
            sha: candidate,
            merge_method: mergeMethod,
          }),
        });
        apiStatus = res.status as 200 | 405 | 409;
        const data = (await res.json()) as { sha?: string; message?: string };
        if (res.ok) {
          mergedSha = data.sha ?? null;
        } else {
          errorMessage = data.message || `HTTP ${res.status}`;
        }
      }
    } catch (err) {
      const errText = this.redact(String(err));
      this.db
        .update(merges)
        .set({ status: 'failed', error: errText, endedAt: this.nowDate() })
        .where(eq(merges.id, mergeRow.id))
        .run();
      return { ok: false, error: `GitHub API network call failed: ${errText}` };
    }

    // AC-2: 409 Conflict -> head changed -> T11
    if (apiStatus === 409) {
      this.db
        .update(merges)
        .set({ status: 'failed', error: '409 Conflict: head changed or cannot be merged', endedAt: this.nowDate() })
        .where(eq(merges.id, mergeRow.id))
        .run();

      // Trigger poll to detect new remote head and transition to TESTING (T11)
      await this.poller.pollPullRequest(pr.id);
      return { ok: false, reverificationRequired: true, error: 'GitHub rejected merge with 409: remote head changed or merge conflict' };
    }

    // AC-3: 405 Method Not Allowed -> story stays in AWAITING_MERGE
    if (apiStatus === 405) {
      this.db
        .update(merges)
        .set({ status: 'failed', error: `405 Method Not Allowed: ${errorMessage}`, endedAt: this.nowDate() })
        .where(eq(merges.id, mergeRow.id))
        .run();
      return { ok: false, status405: true, error: `GitHub rejected merge (405): ${errorMessage ?? 'Base branch protected or PR not mergeable'}` };
    }

    if (apiStatus !== 200 || !mergedSha) {
      this.db
        .update(merges)
        .set({ status: 'failed', error: errorMessage ?? 'Unknown merge error', endedAt: this.nowDate() })
        .where(eq(merges.id, mergeRow.id))
        .run();
      return { ok: false, error: `Merge failed: ${errorMessage}` };
    }

    // 200 Success!
    this.db
      .update(merges)
      .set({ status: 'succeeded', mergedSha, baseAfter: mergedSha, endedAt: this.nowDate() })
      .where(eq(merges.id, mergeRow.id))
      .run();

    this.db
      .update(pullRequests)
      .set({ state: 'merged', mergeCommitSha: mergedSha, lastPolledAt: this.nowDate() })
      .where(eq(pullRequests.id, pr.id))
      .run();

    // Fetch merged commit into local base branch
    try {
      if (this.gitFetchRunner) {
        await this.gitFetchRunner(project.repoPath, project.baseBranch, auth.token);
      } else {
        await gitWithCredentials(['fetch', 'origin', project.baseBranch], {
          cwd: project.repoPath,
          token: auth.token,
        });
      }
      execFileSync('git', ['update-ref', `refs/heads/${project.baseBranch}`, mergedSha], { cwd: project.repoPath });
    } catch {
      // Local ref update failure is non-fatal for GitHub remote merge
    }

    // AC-4: Post-merge verification checks on the merged commit
    const verification = await this.verification.verifyPostMerge({ storyId: story.id, mergedSha });
    if (!verification.ok) {
      const detail = verification.error ?? 'Post-merge checks failed on GitHub merged commit';
      this.workflow.transition({
        storyId: story.id,
        event: { type: 'fail', reason: 'post_merge_failed', detail },
        actor: 'system',
      });
      this.bus.notify(1);
      return { ok: false, mergedSha, error: detail };
    }

    // Transition to DONE (T10)
    const transition = this.workflow.transition({
      storyId: story.id,
      event: { type: 'merge_completed', mergedSha },
      actor: 'system',
    });
    if (!transition.ok) {
      return {
        ok: false,
        mergedSha,
        error: `Transition to DONE failed: ${transition.failedGuards?.map((g) => g.reason).join('; ') ?? transition.code}`,
      };
    }
    this.bus.notify(1);

    this.db.insert(remoteSyncRuns).values({
      projectId: project.id,
      kind: 'merge',
      status: 'succeeded',
      shaAfter: mergedSha,
      detail: `Remote merged PR #${pr.number} (SHA: ${mergedSha})`,
      startedAt,
      endedAt: this.nowDate(),
    }).run();

    return { ok: true, mergedSha };
  }

  /**
   * External merge verification (AC-5): when remote_merge=off or external merge on GitHub.
   * Verifies that the merged commit contains the candidate.
   */
  async handleExternalMerge(storyId: number): Promise<RemoteMergeResult> {
    const startedAt = this.nowDate();
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story || !story.candidateSha) return { ok: false, error: 'Story not found or lacks candidateSha' };

    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.storyId, storyId)).get();
    if (!pr || pr.state !== 'merged' || !pr.mergeCommitSha) {
      return { ok: false, error: 'No merged PR found for story' };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: 'Project not found' };

    const candidate = story.candidateSha;
    const mergedSha = pr.mergeCommitSha;

    // Fetch the merge commit locally to inspect it
    const auth = await this.authService.getValidAccessToken();
    if (auth) {
      try {
        if (this.gitFetchRunner) {
          await this.gitFetchRunner(project.repoPath, project.baseBranch, auth.token);
        } else {
          await gitWithCredentials(['fetch', 'origin', project.baseBranch], {
            cwd: project.repoPath,
            token: auth.token,
          });
        }
      } catch {
        // continue to check ancestry
      }
    }

    // AC-5: Check candidate containment
    const containsCandidate = isAncestor(project.repoPath, candidate, mergedSha);
    if (!containsCandidate) {
      const detail = `External merge commit ${mergedSha} does not contain approved candidate ${candidate}`;
      this.workflow.transition({
        storyId,
        event: {
          type: 'fail',
          reason: 'environment',
          detail,
        },
        actor: 'system',
      });
      this.bus.notify(1);
      return { ok: false, error: detail };
    }

    // Record succeeded external merge
    this.db
      .insert(merges)
      .values({
        storyId,
        method: 'github_external',
        approvedSha: candidate,
        mergedSha,
        baseAfter: mergedSha,
        pullRequestId: pr.id,
        status: 'succeeded',
        startedAt,
        endedAt: this.nowDate(),
      })
      .run();

    // Run post-merge checks
    const verification = await this.verification.verifyPostMerge({ storyId, mergedSha });
    if (!verification.ok) {
      const detail = verification.error ?? 'Post-merge checks failed on external merge';
      this.workflow.transition({
        storyId,
        event: { type: 'fail', reason: 'post_merge_failed', detail },
        actor: 'system',
      });
      this.bus.notify(1);
      return { ok: false, mergedSha, error: detail };
    }

    // Transition to DONE (T10)
    const transition = this.workflow.transition({
      storyId,
      event: { type: 'merge_completed', mergedSha },
      actor: 'system',
    });
    this.bus.notify(1);

    return { ok: transition.ok, mergedSha };
  }
}
