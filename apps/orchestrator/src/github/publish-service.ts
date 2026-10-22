// apps/orchestrator/src/github/publish-service.ts
import { ProjectSettings } from '@aik/contracts';
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
import { gitWithCredentials } from '../git/git.ts';
import { systemClock, type Clock } from '../time.ts';
import { formatPullRequestBody, gatherPullRequestBodyData } from './pr-evidence.ts';
import type { GitHubAuthService } from './service.ts';

export interface GitHubPullsApi {
  createPull: (
    owner: string,
    repo: string,
    data: { title: string; head: string; base: string; body: string },
    token: string,
  ) => Promise<{ number: number; html_url: string; state: string }>;
  updatePull: (
    owner: string,
    repo: string,
    pullNumber: number,
    data: { title?: string; body?: string },
    token: string,
  ) => Promise<{ number: number; html_url: string; state: string }>;
}

export interface GitHubPublishServiceDeps {
  db: AikDb;
  authService: GitHubAuthService;
  now?: Clock;
  redact?: (text: string) => string;
  pullsApi?: GitHubPullsApi;
  gitPushRunner?: (
    repoPath: string,
    branchName: string,
    candidateSha: string,
    token: string,
    expectedRemoteSha?: string,
  ) => Promise<void>;
}

export interface PublishResult {
  ok: boolean;
  pullRequest?: {
    id: number;
    number: number;
    url: string;
    headSha: string;
  };
  forceWithLeaseFailed?: boolean;
  error?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 30);
}

export class GitHubPublishService {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly pullsApi?: GitHubPullsApi;
  private readonly gitPushRunner?: (
    repoPath: string,
    branchName: string,
    candidateSha: string,
    token: string,
    expectedRemoteSha?: string,
  ) => Promise<void>;

  constructor(deps: GitHubPublishServiceDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.pullsApi = deps.pullsApi;
    this.gitPushRunner = deps.gitPushRunner;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async publishStory(storyId: number): Promise<PublishResult> {
    const startedAt = this.nowDate();
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story) return { ok: false, error: `Story ${storyId} not found` };
    if (!story.candidateSha) return { ok: false, error: `Story ${story.key} lacks a candidateSha` };

    if (story.status !== 'AWAITING_MERGE') {
      return { ok: false, error: `Story ${story.key} is in status ${story.status}; must be AWAITING_MERGE to publish` };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: `Project not found for story ${story.key}` };

    const settings = ProjectSettings.parse(project.settings);
    // AC-4: publish=off never pushes
    if (!settings.publish) {
      return { ok: false, error: `Publishing is disabled for project ${project.key} (publish setting is off)` };
    }

    // AC-1: No push happens without approve_publish
    const approval = this.db
      .select()
      .from(mergeApprovals)
      .where(
        and(
          eq(mergeApprovals.storyId, story.id),
          eq(mergeApprovals.kind, 'publish'),
          eq(mergeApprovals.commitSha, story.candidateSha),
        ),
      )
      .get();
    if (!approval) {
      return { ok: false, error: `No publish approval found for candidate ${story.candidateSha}` };
    }

    // Determine target repository connection
    let repoConn = project.repositoryConnectionId
      ? this.db.select().from(repositoryConnections).where(eq(repositoryConnections.id, project.repositoryConnectionId)).get()
      : null;

    if (!repoConn && project.remoteUrl) {
      const match = project.remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/i);
      if (match && match[1] && match[2]) {
        repoConn = this.db
          .select()
          .from(repositoryConnections)
          .where(and(eq(repositoryConnections.owner, match[1]), eq(repositoryConnections.name, match[2])))
          .get();
      }
    }

    if (!repoConn) {
      return { ok: false, error: 'No GitHub repository connection linked to this project' };
    }

    // Get auth token
    const auth = await this.authService.getValidAccessToken();
    if (!auth) {
      return { ok: false, error: 'GitHub authentication expired or unavailable' };
    }

    // Determine branch name
    const branchName = story.branchName || `ai/${story.key}-${slugify(story.title)}`;
    if (!story.branchName) {
      this.db
        .update(userStories)
        .set({ branchName, updatedAt: this.nowDate() })
        .where(eq(userStories.id, story.id))
        .run();
    }

    // Check for existing PR
    const existingPr = this.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.storyId, story.id))
      .get();

    // Push branch via credential helper
    try {
      if (this.gitPushRunner) {
        await this.gitPushRunner(
          project.repoPath,
          branchName,
          story.candidateSha,
          auth.token,
          existingPr?.headSha,
        );
      } else {
        const pushArgs = existingPr?.headSha
          ? ['push', `--force-with-lease=refs/heads/${branchName}:${existingPr.headSha}`, 'origin', branchName]
          : ['push', '-u', 'origin', branchName];

        await gitWithCredentials(pushArgs, {
          cwd: project.repoPath,
          token: auth.token,
        });
      }

      this.db.insert(remoteSyncRuns).values({
        projectId: project.id,
        kind: 'push',
        status: 'succeeded',
        shaBefore: existingPr?.headSha ?? null,
        shaAfter: story.candidateSha,
        startedAt,
        endedAt: this.nowDate(),
      }).run();
    } catch (err) {
      const errorMsg = String(err);
      const isLeaseFail = /stale info|force-with-lease|non-fast-forward|failed to push/i.test(errorMsg);

      this.db.insert(remoteSyncRuns).values({
        projectId: project.id,
        kind: 'push',
        status: 'failed',
        detail: this.redact(errorMsg),
        startedAt,
        endedAt: this.nowDate(),
      }).run();

      // AC-3: force-with-lease mismatch -> no overwrite -> head-drift handling
      if (isLeaseFail) {
        return {
          ok: false,
          forceWithLeaseFailed: true,
          error: 'Remote PR branch has changed since last sync; force-with-lease prevented overwrite',
        };
      }

      return { ok: false, error: `Failed to push branch: ${this.redact(errorMsg)}` };
    }

    // Gather DB evidence and build PR body (AC-2, §14)
    const baseRef = `refs/heads/${project.baseBranch}`;
    const evidenceData = await gatherPullRequestBodyData(this.db, story.id, project.repoPath, baseRef);
    const prBody = formatPullRequestBody(evidenceData);
    const prTitle = `${story.key}: ${story.title}`;

    // GitHub API call
    try {
      if (existingPr) {
        // Update existing PR
        if (this.pullsApi) {
          await this.pullsApi.updatePull(repoConn.owner, repoConn.name, existingPr.number, {
            title: prTitle,
            body: prBody,
          }, auth.token);
        } else {
          const res = await fetch(`https://api.github.com/repos/${repoConn.owner}/${repoConn.name}/pulls/${existingPr.number}`, {
            method: 'PATCH',
            headers: {
              authorization: `Bearer ${auth.token}`,
              accept: 'application/vnd.github+json',
              'content-type': 'application/json',
              'user-agent': 'AI-Kanban',
            },
            body: JSON.stringify({ title: prTitle, body: prBody }),
          });
          if (!res.ok) {
            throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
          }
        }

        this.db
          .update(pullRequests)
          .set({
            headSha: story.candidateSha,
            lastPolledAt: this.nowDate(),
          })
          .where(eq(pullRequests.id, existingPr.id))
          .run();

        return {
          ok: true,
          pullRequest: {
            id: existingPr.id,
            number: existingPr.number,
            url: existingPr.url,
            headSha: story.candidateSha,
          },
        };
      } else {
        // Create new PR
        let createdNumber: number;
        let createdUrl: string;

        if (this.pullsApi) {
          const res = await this.pullsApi.createPull(repoConn.owner, repoConn.name, {
            title: prTitle,
            head: branchName,
            base: project.baseBranch,
            body: prBody,
          }, auth.token);
          createdNumber = res.number;
          createdUrl = res.html_url;
        } else {
          const res = await fetch(`https://api.github.com/repos/${repoConn.owner}/${repoConn.name}/pulls`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${auth.token}`,
              accept: 'application/vnd.github+json',
              'content-type': 'application/json',
              'user-agent': 'AI-Kanban',
            },
            body: JSON.stringify({
              title: prTitle,
              head: branchName,
              base: project.baseBranch,
              body: prBody,
            }),
          });
          if (!res.ok) {
            throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
          }
          const data = (await res.json()) as { number: number; html_url: string };
          createdNumber = data.number;
          createdUrl = data.html_url;
        }

        const prRow = this.db
          .insert(pullRequests)
          .values({
            storyId: story.id,
            repositoryConnectionId: repoConn.id,
            number: createdNumber,
            url: createdUrl,
            headBranch: branchName,
            headSha: story.candidateSha,
            baseBranch: project.baseBranch,
            state: 'open',
            lastPolledAt: this.nowDate(),
          })
          .returning()
          .get();

        this.db.insert(remoteSyncRuns).values({
          projectId: project.id,
          kind: 'pr_create',
          status: 'succeeded',
          shaAfter: story.candidateSha,
          detail: `Created PR #${createdNumber}: ${createdUrl}`,
          startedAt,
          endedAt: this.nowDate(),
        }).run();

        return {
          ok: true,
          pullRequest: {
            id: prRow.id,
            number: prRow.number,
            url: prRow.url,
            headSha: prRow.headSha,
          },
        };
      }
    } catch (err) {
      const errorMsg = String(err);
      this.db.insert(remoteSyncRuns).values({
        projectId: project.id,
        kind: 'pr_create',
        status: 'failed',
        detail: this.redact(errorMsg),
        startedAt,
        endedAt: this.nowDate(),
      }).run();
      return { ok: false, error: `GitHub PR operation failed: ${this.redact(errorMsg)}` };
    }
  }
}
