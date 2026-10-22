// apps/orchestrator/src/github/clone-service.ts
import {
  normalizeGitHubRemoteUrl,
  type CloneRepositoryRequest,
  type GitHubRepositoryDTO,
  type LinkRepositoryRequest,
  type ProjectDTO,
} from '@aik/contracts';
import { projects, remoteSyncRuns, repositoryConnections, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import { git, gitWithCredentials, stripCredentials } from '../git/git.ts';
import type { ProjectService } from '../projects/service.ts';
import { systemClock, type Clock } from '../time.ts';
import type { GitHubRepositoryService } from './repository-service.ts';
import type { GitHubAuthService } from './service.ts';

export interface GitHubCloneServiceDeps {
  db: AikDb;
  authService: GitHubAuthService;
  repoService: GitHubRepositoryService;
  projectService: ProjectService;
  now?: Clock;
  gitCloneRunner?: (url: string, targetPath: string, token: string) => Promise<void>;
}

export class GitHubCloneService {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly repoService: GitHubRepositoryService;
  private readonly projectService: ProjectService;
  private readonly now: Clock;
  private readonly gitCloneRunner?: (url: string, targetPath: string, token: string) => Promise<void>;

  constructor(deps: GitHubCloneServiceDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.repoService = deps.repoService;
    this.projectService = deps.projectService;
    this.now = deps.now ?? systemClock;
    this.gitCloneRunner = deps.gitCloneRunner;
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async cloneRepository(repoConnectionId: number, request: CloneRepositoryRequest): Promise<ProjectDTO> {
    const repoRow = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, repoConnectionId))
      .get();

    if (!repoRow) {
      throw new ApiHttpError(404, 'NOT_FOUND', `Repository connection ${repoConnectionId} not found`);
    }

    if (!path.isAbsolute(request.parentDirectory)) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', 'parentDirectory must be an absolute path');
    }

    const parent = path.resolve(request.parentDirectory);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Parent directory does not exist: ${parent}`);
    }

    const targetDir = path.join(parent, repoRow.name);
    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir);
      if (files.length > 0) {
        throw new ApiHttpError(400, 'GUARD_FAILED', `Target directory already exists and is not empty: ${targetDir}`);
      }
    }

    const auth = await this.authService.getValidAccessToken();
    if (!auth) {
      throw new ApiHttpError(401, 'UNAUTHORIZED', 'GitHub is not connected');
    }

    const repoUrl = `https://github.com/${repoRow.owner}/${repoRow.name}.git`;
    const startedAt = this.nowDate();

    // 1. Execute clone
    try {
      if (this.gitCloneRunner) {
        await this.gitCloneRunner(repoUrl, targetDir, auth.token);
      } else {
        await gitWithCredentials(['clone', repoUrl, targetDir], {
          cwd: parent,
          token: auth.token,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiHttpError(500, 'INTERNAL', `Failed to clone repository: ${msg}`);
    }

    // 2. Resolve head sha and canonical path
    const resolvedPath = fs.realpathSync.native(targetDir);
    let headSha: string | null = null;
    try {
      headSha = await git(['rev-parse', 'HEAD'], { cwd: resolvedPath });
    } catch {
      // Best effort
    }

    // 3. Create or link project
    const projectKey =
      request.projectKey ??
      (repoRow.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'REPO');
    const projectName = request.projectName ?? repoRow.name;

    const project = await this.projectService.create({
      name: projectName,
      key: projectKey,
      repoPath: resolvedPath,
      baseBranch: repoRow.defaultBranch,
    });

    // 4. Update repository connection and project link
    const endedAt = this.nowDate();
    this.db
      .update(repositoryConnections)
      .set({ localPath: resolvedPath, lastSyncedAt: endedAt })
      .where(eq(repositoryConnections.id, repoRow.id))
      .run();

    this.db
      .update(projects)
      .set({ repositoryConnectionId: repoRow.id, remoteUrl: repoUrl, updatedAt: endedAt })
      .where(eq(projects.id, project.id))
      .run();

    // 5. Audit log in remote_sync_runs
    this.db
      .insert(remoteSyncRuns)
      .values({
        projectId: project.id,
        kind: 'clone',
        status: 'succeeded',
        shaAfter: headSha,
        startedAt,
        endedAt,
      })
      .run();

    return this.projectService.get(project.id);
  }

  async linkRepository(
    repoConnectionId: number,
    request: LinkRepositoryRequest
  ): Promise<{ repository: GitHubRepositoryDTO; project: ProjectDTO }> {
    const repoRow = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.id, repoConnectionId))
      .get();

    if (!repoRow) {
      throw new ApiHttpError(404, 'NOT_FOUND', `Repository connection ${repoConnectionId} not found`);
    }

    if (!path.isAbsolute(request.localPath)) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', 'localPath must be an absolute path');
    }

    const requested = path.resolve(request.localPath);
    if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Folder does not exist: ${requested}`);
    }

    let top: string;
    try {
      top = await git(['rev-parse', '--show-toplevel'], { cwd: requested });
    } catch {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Folder is not inside a git repository: ${requested}`);
    }

    const root = fs.realpathSync.native(path.resolve(top));

    // Validate remote URL matches expected repo
    let remoteUrl: string;
    try {
      remoteUrl = await git(['remote', 'get-url', 'origin'], { cwd: root });
    } catch {
      throw new ApiHttpError(400, 'GUARD_FAILED', `Repository has no origin remote configured`);
    }

    const normalizedRemote = normalizeGitHubRemoteUrl(remoteUrl);
    const expectedCanonical = `${repoRow.owner}/${repoRow.name}`.toLowerCase();

    if (!normalizedRemote || normalizedRemote !== expectedCanonical) {
      const sanitizedRemote = stripCredentials(remoteUrl);
      throw new ApiHttpError(
        400,
        'GUARD_FAILED',
        `Remote URL mismatch: local repository is linked to '${sanitizedRemote}', expected '${repoRow.owner}/${repoRow.name}'`
      );
    }

    const now = this.nowDate();
    // Clear repositoryConnectionId from any other project previously linked to this repo
    this.db
      .update(projects)
      .set({ repositoryConnectionId: null, updatedAt: now })
      .where(eq(projects.repositoryConnectionId, repoRow.id))
      .run();

    // Update repository connection local path
    this.db
      .update(repositoryConnections)
      .set({ localPath: root, lastSyncedAt: now })
      .where(eq(repositoryConnections.id, repoRow.id))
      .run();

    // Check if project already exists for this path
    const existingProjects = this.projectService.list();
    let project = existingProjects.find(
      (p) => path.resolve(p.repoPath).toLowerCase() === root.toLowerCase()
    );

    if (project) {
      this.db
        .update(projects)
        .set({ repositoryConnectionId: repoRow.id, remoteUrl: stripCredentials(remoteUrl), updatedAt: now })
        .where(eq(projects.id, project.id))
        .run();
      project = this.projectService.get(project.id);
    } else {
      const projectKey =
        request.projectKey ??
        (repoRow.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'REPO');
      const projectName = request.projectName ?? repoRow.name;

      project = await this.projectService.create({
        name: projectName,
        key: projectKey,
        repoPath: root,
        baseBranch: repoRow.defaultBranch,
      });

      this.db
        .update(projects)
        .set({ repositoryConnectionId: repoRow.id, remoteUrl: stripCredentials(remoteUrl), updatedAt: now })
        .where(eq(projects.id, project.id))
        .run();
      project = this.projectService.get(project.id);
    }

    const updatedRepos = await this.repoService.listRepositories({ forceRefresh: false });
    const repoDto = updatedRepos.repositories.find((r) => r.id === repoRow.id)!;

    return {
      repository: repoDto,
      project,
    };
  }
}
