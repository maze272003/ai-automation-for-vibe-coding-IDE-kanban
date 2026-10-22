// apps/orchestrator/src/github/repository-service.ts
import {
  type GitHubInstallationDTO,
  type GitHubOrgNoticeDTO,
  type GitHubRepositoryDTO,
  type ListRepositoriesResponse,
  normalizeGitHubRemoteUrl,
} from '@aik/contracts';
import { projects, repositoryConnections, type AikDb } from '@aik/db';
import { eq, ne } from 'drizzle-orm';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import { systemClock, type Clock } from '../time.ts';
import type { GitHubAuthService } from './service.ts';

export interface GitHubRepositoryServiceDeps {
  db: AikDb;
  authService: GitHubAuthService;
  apiBaseUrl?: string;
  now?: Clock;
  fetchFn?: typeof fetch;
}

export class GitHubRepositoryService {
  private readonly db: AikDb;
  private readonly authService: GitHubAuthService;
  private readonly apiBaseUrl: string;
  private readonly now: Clock;
  private readonly fetch: typeof fetch;

  private cachedInstallationsEtag: string | null = null;
  private readonly cachedRepoEtags = new Map<number, string>();
  private cachedInstallations: GitHubInstallationDTO[] = [];
  private rateLimitInfo?: { remaining: number; reset: number };

  constructor(deps: GitHubRepositoryServiceDeps) {
    this.db = deps.db;
    this.authService = deps.authService;
    this.apiBaseUrl = deps.apiBaseUrl ?? 'https://api.github.com';
    this.now = deps.now ?? systemClock;
    this.fetch = deps.fetchFn ?? globalThis.fetch;
  }

  async listRepositories(options?: { forceRefresh?: boolean }): Promise<ListRepositoriesResponse> {
    const auth = await this.authService.getValidAccessToken();
    if (!auth) {
      throw new ApiHttpError(401, 'UNAUTHORIZED', 'GitHub is not connected');
    }

    const nowMs = this.now();
    const existing = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.githubConnectionId, auth.connection.id))
      .all();

    const isStale =
      existing.length === 0 ||
      existing.some((r) => !r.lastSyncedAt || nowMs - r.lastSyncedAt.getTime() > 10 * 60 * 1000);

    const notices: GitHubOrgNoticeDTO[] = [];

    if (options?.forceRefresh || isStale) {
      await this.syncRepositoriesFromGitHub(auth.token, auth.connection.id, notices);
    }

    return this.buildListResponse(auth.connection.id, notices);
  }

  private async syncRepositoriesFromGitHub(
    token: string,
    githubConnectionId: number,
    notices: GitHubOrgNoticeDTO[]
  ): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // 1. Fetch user installations
    const instHeaders = { ...headers };
    if (this.cachedInstallationsEtag) {
      instHeaders['If-None-Match'] = this.cachedInstallationsEtag;
    }

    const instRes = await this.fetch(`${this.apiBaseUrl}/user/installations`, { headers: instHeaders });
    this.recordRateLimit(instRes.headers);

    if (instRes.status === 200) {
      this.cachedInstallationsEtag = instRes.headers.get('etag');
      const data = (await instRes.json()) as {
        installations: Array<{
          id: number;
          account: { login: string; type: 'User' | 'Organization'; avatar_url?: string };
          html_url: string;
        }>;
      };
      this.cachedInstallations = (data.installations ?? []).map((i) => ({
        id: i.id,
        account: {
          login: i.account.login,
          type: i.account.type === 'Organization' ? 'Organization' : 'User',
          avatarUrl: i.account.avatar_url,
        },
        htmlUrl: i.html_url,
      }));
    } else if (instRes.status !== 304) {
      this.checkSsoHeader(instRes.headers, notices);
    }

    // 2. Fetch repositories for each installation
    const nowTs = new Date(this.now());

    for (const inst of this.cachedInstallations) {
      const repoHeaders = { ...headers };
      const cachedEtag = this.cachedRepoEtags.get(inst.id);
      if (cachedEtag) {
        repoHeaders['If-None-Match'] = cachedEtag;
      }

      const repoRes = await this.fetch(
        `${this.apiBaseUrl}/user/installations/${inst.id}/repositories?per_page=100`,
        { headers: repoHeaders }
      );
      this.recordRateLimit(repoRes.headers);

      if (repoRes.status === 200) {
        const etag = repoRes.headers.get('etag');
        if (etag) {
          this.cachedRepoEtags.set(inst.id, etag);
        }
        const repoData = (await repoRes.json()) as {
          repositories: Array<{
            id: number;
            name: string;
            full_name: string;
            owner: { login: string };
            description: string | null;
            default_branch: string;
            private: boolean;
            visibility?: 'public' | 'private' | 'internal';
            permissions?: { admin: boolean; push: boolean; pull: boolean };
          }>;
        };

        for (const r of repoData.repositories ?? []) {
          const vis: 'public' | 'private' | 'internal' =
            r.visibility ?? (r.private ? 'private' : 'public');
          const perms = r.permissions ?? { admin: false, push: false, pull: true };

          const existingRow = this.db
            .select()
            .from(repositoryConnections)
            .where(eq(repositoryConnections.githubRepoId, r.id))
            .get();

          if (existingRow) {
            this.db
              .update(repositoryConnections)
              .set({
                installationId: inst.id,
                owner: r.owner.login,
                name: r.name,
                description: r.description,
                defaultBranch: r.default_branch,
                visibility: vis,
                permissions: perms,
                etag,
                lastSyncedAt: nowTs,
              })
              .where(eq(repositoryConnections.id, existingRow.id))
              .run();
          } else {
            this.db
              .insert(repositoryConnections)
              .values({
                githubConnectionId,
                githubRepoId: r.id,
                installationId: inst.id,
                owner: r.owner.login,
                name: r.name,
                description: r.description,
                defaultBranch: r.default_branch,
                visibility: vis,
                permissions: perms,
                etag,
                lastSyncedAt: nowTs,
              })
              .run();
          }
        }
      } else if (repoRes.status !== 304) {
        this.checkSsoHeader(repoRes.headers, notices);
      }
    }

    // 3. Check for orgs that may need app installation
    try {
      const orgsRes = await this.fetch(`${this.apiBaseUrl}/user/orgs`, { headers });
      if (orgsRes.status === 200) {
        const orgs = (await orgsRes.json()) as Array<{ login: string }>;
        const installedLogins = new Set(
          this.cachedInstallations
            .filter((i) => i.account.type === 'Organization')
            .map((i) => i.account.login.toLowerCase())
        );

        for (const org of orgs ?? []) {
          if (!installedLogins.has(org.login.toLowerCase())) {
            notices.push({
              org: org.login,
              type: 'install_needed',
              url: `https://github.com/apps/ai-kanban/installations/new`,
            });
          }
        }
      }
    } catch {
      // Best-effort org notice check
    }
  }

  private checkSsoHeader(headers: Headers, notices: GitHubOrgNoticeDTO[]): void {
    const ssoHeader = headers.get('x-github-sso');
    if (ssoHeader && ssoHeader.includes('required')) {
      const match = ssoHeader.match(/url=([^;\s]+)/);
      const url = match ? match[1]! : 'https://github.com';
      notices.push({
        org: 'SSO Protected Organization',
        type: 'sso_needed',
        url,
      });
    }
  }

  private recordRateLimit(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining !== null && reset !== null) {
      this.rateLimitInfo = {
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
      };
    }
  }

  private buildListResponse(
    githubConnectionId: number,
    notices: GitHubOrgNoticeDTO[]
  ): ListRepositoriesResponse {
    const rows = this.db
      .select()
      .from(repositoryConnections)
      .where(eq(repositoryConnections.githubConnectionId, githubConnectionId))
      .all();

    const allProjects = this.db.select().from(projects).where(ne(projects.status, 'archived')).all();

    const dtos: GitHubRepositoryDTO[] = rows.map((r) => {
      const canonicalName = `${r.owner}/${r.name}`.toLowerCase();
      const rPath = r.localPath ? path.resolve(r.localPath).toLowerCase() : null;

      const linkedProject = allProjects.find((p) => {
        if (rPath) {
          return path.resolve(p.repoPath).toLowerCase() === rPath;
        }
        return (
          p.repositoryConnectionId === r.id ||
          (p.remoteUrl && normalizeGitHubRemoteUrl(p.remoteUrl) === canonicalName)
        );
      });

      return {
        id: r.id,
        githubRepoId: r.githubRepoId,
        owner: r.owner,
        name: r.name,
        fullName: `${r.owner}/${r.name}`,
        description: r.description,
        defaultBranch: r.defaultBranch,
        visibility: r.visibility as GitHubRepositoryDTO['visibility'],
        permissions: r.permissions ?? { admin: false, push: false, pull: true },
        installationId: r.installationId,
        localPath: r.localPath ?? linkedProject?.repoPath ?? null,
        linkedProjectId: linkedProject ? linkedProject.id : null,
        lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.getTime() : null,
      };
    });

    return {
      repositories: dtos,
      installations: this.cachedInstallations,
      notices,
      rateLimit: this.rateLimitInfo,
    };
  }
}
