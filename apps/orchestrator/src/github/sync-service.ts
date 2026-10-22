// apps/orchestrator/src/github/sync-service.ts
import { ProjectSettings } from '@aik/contracts';
import {
  projects,
  pullRequests,
  remoteSyncRuns,
  userStories,
  type AikDb,
} from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import type { EventBus } from '../events/bus.ts';
import { git, gitWithCredentials } from '../git/git.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { GitHubAuthService } from './service.ts';

export interface GitHubSyncServiceDeps {
  db: AikDb;
  authService: GitHubAuthService;
  workflow: WorkflowService;
  bus: EventBus;
  now?: Clock;
  redact?: (text: string) => string;
  gitFetchRunner?: (repoPath: string, baseBranch: string, token: string) => Promise<string>;
  gitPushRunner?: (repoPath: string, branchName: string, expectedRemoteSha: string, token: string) => Promise<void>;
}

export interface SyncResult {
  ok: boolean;
  baseMoved: boolean;
  syncedSha?: string;
  conflict?: boolean;
  pushedToPr?: boolean;
  error?: string;
}

const runGit = (cwd: string, args: string[]): { code: number; output: string } => {
  try {
    return { code: 0, output: execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const text = (b: string | Buffer | undefined): string => (typeof b === 'string' ? b : (b?.toString('utf8') ?? ''));
    return { code: typeof e.status === 'number' ? e.status : -1, output: `${text(e.stdout)}${text(e.stderr)}` };
  }
};

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

export class GitHubSyncService {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly gitFetchRunner?: (repoPath: string, baseBranch: string, token: string) => Promise<string>;
  private readonly gitPushRunner?: (repoPath: string, branchName: string, expectedRemoteSha: string, token: string) => Promise<void>;

  constructor(deps: GitHubSyncServiceDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.gitFetchRunner = deps.gitFetchRunner;
    this.gitPushRunner = deps.gitPushRunner;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async fetchBase(projectId: number): Promise<{ ok: boolean; sha?: string; error?: string }> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return { ok: false, error: `Project ${projectId} not found` };

    const startedAt = this.nowDate();
    let token = '';

    // If project is connected to GitHub, get valid access token
    if (project.repositoryConnectionId) {
      const auth = await this.authService.getValidAccessToken();
      if (!auth) {
        const error = 'GitHub authentication expired or unavailable';
        this.db.insert(remoteSyncRuns).values({
          projectId,
          kind: 'fetch',
          status: 'failed',
          detail: error,
          startedAt,
          endedAt: this.nowDate(),
        }).run();
        return { ok: false, error };
      }
      token = auth.token;
    }

    try {
      if (this.gitFetchRunner) {
        const sha = await this.gitFetchRunner(project.repoPath, project.baseBranch, token);
        this.db.insert(remoteSyncRuns).values({
          projectId,
          kind: 'fetch',
          status: 'succeeded',
          shaAfter: sha,
          startedAt,
          endedAt: this.nowDate(),
        }).run();
        return { ok: true, sha };
      }

      if (token) {
        await gitWithCredentials(['fetch', 'origin', project.baseBranch], {
          cwd: project.repoPath,
          token,
        });
      } else {
        await git(['fetch', 'origin', project.baseBranch], { cwd: project.repoPath });
      }

      const remoteHead = execFileSync('git', ['rev-parse', `refs/remotes/origin/${project.baseBranch}`], {
        cwd: project.repoPath,
        encoding: 'utf8',
      }).trim();

      this.db.insert(remoteSyncRuns).values({
        projectId,
        kind: 'fetch',
        status: 'succeeded',
        shaAfter: remoteHead,
        startedAt,
        endedAt: this.nowDate(),
      }).run();

      return { ok: true, sha: remoteHead };
    } catch (err) {
      const error = this.redact(String(err));
      this.db.insert(remoteSyncRuns).values({
        projectId,
        kind: 'fetch',
        status: 'failed',
        detail: error,
        startedAt,
        endedAt: this.nowDate(),
      }).run();
      return { ok: false, error };
    }
  }

  async syncStoryWithBase(storyId: number): Promise<SyncResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, storyId)).get();
    if (!story) return { ok: false, baseMoved: false, error: `Story ${storyId} not found` };
    if (!story.candidateSha) {
      return { ok: false, baseMoved: false, error: `Story ${story.key} has no candidateSha` };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, baseMoved: false, error: `Project not found` };

    // Fetch upstream base branch
    const fetchRes = await this.fetchBase(project.id);
    if (!fetchRes.ok) {
      // Fetch failure -> BLOCKED(auth | environment) per GH-6 AC-3
      const isAuth = /auth|credential|token|unauthorized/i.test(fetchRes.error ?? '');
      this.workflow.transition({
        storyId,
        event: {
          type: 'fail',
          reason: isAuth ? 'auth' : 'environment',
          detail: `Fetch failed: ${fetchRes.error}`,
        },
        actor: 'system',
      });
      this.bus.notify(1);
      return { ok: false, baseMoved: false, error: fetchRes.error };
    }

    const remoteBaseSha = fetchRes.sha;
    if (!remoteBaseSha) {
      return { ok: false, baseMoved: false, error: 'Could not determine remote base SHA' };
    }

    // Check if remote base is ancestor of candidate
    const candidate = story.candidateSha;
    if (isAncestor(project.repoPath, remoteBaseSha, candidate)) {
      // Base has not moved relative to candidate
      return { ok: true, baseMoved: false };
    }

    // Base has moved!
    // Probe merge with merge-tree
    const probe = runGit(project.repoPath, ['merge-tree', '--write-tree', remoteBaseSha, candidate]);
    if (probe.code !== 0 || /CONFLICT/i.test(probe.output)) {
      // Conflict -> REWORK (T12) or BLOCKED(conflict) per GH-6 AC-2
      if (story.attemptCount < story.maxAttempts) {
        this.workflow.transition({
          storyId,
          event: { type: 'merge_conflict' },
          actor: 'system',
        });
      } else {
        this.workflow.transition({
          storyId,
          event: {
            type: 'fail',
            reason: 'conflict',
            detail: 'Merge conflict synchronizing upstream base into candidate',
          },
          actor: 'system',
        });
      }
      this.bus.notify(1);
      return { ok: false, baseMoved: true, conflict: true, error: 'Merge conflict detected' };
    }

    const tree = (probe.output.split(/\r?\n/)[0] ?? '').trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
      return { ok: false, baseMoved: true, error: `Invalid merge-tree output: ${this.redact(tree)}` };
    }

    // Clean merge: create sync commit on story branch
    let syncedSha: string;
    let syncedTree: string;
    try {
      syncedSha = execFileSync(
        'git',
        [
          '-c', 'user.name=AI Kanban Agent',
          '-c', 'user.email=agent@localhost',
          'commit-tree', tree,
          '-p', candidate,
          '-p', remoteBaseSha,
          '-m', `sync: merge ${project.baseBranch} into ${story.key}`,
        ],
        { cwd: project.repoPath, encoding: 'utf8' },
      ).trim();
      syncedTree = execFileSync('git', ['rev-parse', `${syncedSha}^{tree}`], { cwd: project.repoPath, encoding: 'utf8' }).trim();
    } catch (err) {
      return { ok: false, baseMoved: true, error: `Failed to commit sync merge: ${this.redact(String(err))}` };
    }

    // Update story branch ref if it exists
    if (story.branchName) {
      try {
        execFileSync('git', ['update-ref', `refs/heads/${story.branchName}`, syncedSha], { cwd: project.repoPath });
      } catch {
        // branch ref might not exist locally yet
      }
    }

    // Transition story to TESTING (T11)
    const transition = this.workflow.transition({
      storyId,
      event: { type: 'candidate_head_changed', newSha: syncedSha, newTree: syncedTree },
      actor: 'system',
    });
    if (!transition.ok) {
      return {
        ok: false,
        baseMoved: true,
        error: `Failed to transition story to TESTING: ${transition.failedGuards?.map((g) => g.reason).join('; ') ?? transition.code}`,
      };
    }
    this.bus.notify(1);

    // If PR is already published, push updated branch per GH-7 rules
    let pushedToPr = false;
    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.storyId, storyId)).get();
    const settings = ProjectSettings.parse(project.settings);
    if (pr && settings.publish && story.branchName) {
      const auth = await this.authService.getValidAccessToken();
      if (auth) {
        try {
          if (this.gitPushRunner) {
            await this.gitPushRunner(project.repoPath, story.branchName, candidate, auth.token);
          } else {
            await gitWithCredentials(
              ['push', `--force-with-lease=refs/heads/${story.branchName}:${candidate}`, 'origin', story.branchName],
              { cwd: project.repoPath, token: auth.token },
            );
          }
          this.db
            .update(pullRequests)
            .set({ headSha: syncedSha })
            .where(eq(pullRequests.id, pr.id))
            .run();
          pushedToPr = true;
        } catch {
          // Push failed (lease mismatch or network) -> poller will handle head-drift
        }
      }
    }

    return {
      ok: true,
      baseMoved: true,
      syncedSha,
      pushedToPr,
    };
  }
}
