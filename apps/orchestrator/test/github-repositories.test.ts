import { defaultProjectSettings } from '@aik/contracts';
import { githubConnections, projects, repositoryConnections } from '@aik/db';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { GitHubRepositoryService } from '../src/github/repository-service.ts';
import { createTestDb } from './helpers/db.ts';

describe('GitHubRepositoryService', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let mockServer: http.Server;
  let mockPort: number;
  let authService: GitHubAuthService;
  let repoService: GitHubRepositoryService;
  let credentialStore: MemoryCredentialStore;
  let installationRequestCount = 0;

  beforeAll(async () => {
    dbHolder = createTestDb();
    credentialStore = new MemoryCredentialStore();

    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname === '/user/installations') {
        installationRequestCount++;
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === 'W/"inst-etag-1"') {
          res.writeHead(304);
          res.end();
          return;
        }

        res.writeHead(200, {
          'content-type': 'application/json',
          etag: 'W/"inst-etag-1"',
          'x-ratelimit-remaining': '4990',
          'x-ratelimit-reset': '1800000000',
        });
        res.end(
          JSON.stringify({
            total_count: 1,
            installations: [
              {
                id: 101,
                account: {
                  login: 'octocat',
                  type: 'User',
                  avatar_url: 'https://avatars.githubusercontent.com/u/583231',
                },
                html_url: 'https://github.com/settings/installations/101',
              },
            ],
          })
        );
        return;
      }

      if (url.pathname === '/user/installations/101/repositories') {
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === 'W/"repo-etag-1"') {
          res.writeHead(304);
          res.end();
          return;
        }

        res.writeHead(200, {
          'content-type': 'application/json',
          etag: 'W/"repo-etag-1"',
          'x-ratelimit-remaining': '4989',
          'x-ratelimit-reset': '1800000000',
        });
        res.end(
          JSON.stringify({
            total_count: 2,
            repositories: [
              {
                id: 1001,
                name: 'hello-world',
                full_name: 'octocat/hello-world',
                owner: { login: 'octocat' },
                description: 'First test repository',
                default_branch: 'main',
                private: false,
                visibility: 'public',
                permissions: { admin: true, push: true, pull: true },
              },
              {
                id: 1002,
                name: 'secret-sauce',
                full_name: 'octocat/secret-sauce',
                owner: { login: 'octocat' },
                description: 'Proprietary sauce',
                default_branch: 'master',
                private: true,
                visibility: 'private',
                permissions: { admin: false, push: true, pull: true },
              },
            ],
          })
        );
        return;
      }

      if (url.pathname === '/user/orgs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              login: 'mega-corp',
              avatar_url: 'https://avatars.githubusercontent.com/u/99999',
            },
          ])
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as AddressInfo).port;
        resolve();
      });
    });

    const apiBaseUrl = `http://127.0.0.1:${mockPort}`;
    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
      apiBaseUrl,
      githubBaseUrl: apiBaseUrl,
    });

    repoService = new GitHubRepositoryService({
      db: dbHolder.db,
      authService,
      apiBaseUrl,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    dbHolder.close();
  });

  it('rejects listing repositories when not connected', async () => {
    await expect(repoService.listRepositories()).rejects.toThrow('GitHub is not connected');
  });

  it('fetches installations, repositories, and notices and persists to database', async () => {
    // Arrange: Create active GitHub connection & token
    const now = new Date();
    dbHolder.db
      .insert(githubConnections)
      .values({
        githubUserId: 583231,
        login: 'octocat',
        appClientId: 'Iv1.testclientid',
        tokenRef: 'AiKanban/github/583231',
        status: 'connected',
        accessExpiresAt: new Date(now.getTime() + 8 * 3600 * 1000),
        refreshExpiresAt: new Date(now.getTime() + 180 * 86400 * 1000),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    await credentialStore.saveTokens(583231, {
      accessToken: 'gho_mock_access_token',
      refreshToken: 'ghr_mock_refresh_token',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: now.getTime(),
      expiresIn: 28800,
      refreshTokenExpiresIn: 15552000,
    });

    // Act
    const res = await repoService.listRepositories({ forceRefresh: true });

    // Assert DTO
    expect(res.repositories).toHaveLength(2);
    expect(res.repositories[0]?.fullName).toBe('octocat/hello-world');
    expect(res.repositories[0]?.permissions.push).toBe(true);
    expect(res.repositories[1]?.visibility).toBe('private');

    expect(res.installations).toHaveLength(1);
    expect(res.installations[0]?.account.login).toBe('octocat');

    expect(res.notices).toHaveLength(1);
    expect(res.notices[0]?.org).toBe('mega-corp');
    expect(res.notices[0]?.type).toBe('install_needed');

    expect(res.rateLimit?.remaining).toBe(4989);

    // Assert DB persistence
    const saved = dbHolder.db.select().from(repositoryConnections).all();
    expect(saved).toHaveLength(2);
    expect(saved.map((r) => r.name)).toContain('hello-world');
    expect(saved.map((r) => r.name)).toContain('secret-sauce');
  });

  it('reuses cache when called without forceRefresh and cache is recent', async () => {
    const countBefore = installationRequestCount;
    const res = await repoService.listRepositories({ forceRefresh: false });
    expect(res.repositories).toHaveLength(2);
    expect(installationRequestCount).toBe(countBefore);
  });

  it('sends ETag on refresh and handles 304 Not Modified', async () => {
    const res = await repoService.listRepositories({ forceRefresh: true });
    expect(res.repositories).toHaveLength(2);
  });

  it('populates linkedProjectId and preserves localPath when a project exists', async () => {
    // Arrange: create a project matching repository_connections
    const repoRow = dbHolder.db.select().from(repositoryConnections).all()[0]!;
    const now = new Date();
    const proj = dbHolder.db
      .insert(projects)
      .values({
        key: 'HW',
        name: 'Hello World',
        repoPath: 'C:\\projects\\hello-world',
        baseBranch: 'main',
        remoteUrl: 'https://github.com/octocat/hello-world.git',
        repositoryConnectionId: repoRow.id,
        settings: defaultProjectSettings(),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Act
    const res = await repoService.listRepositories({ forceRefresh: false });
    const matched = res.repositories.find((r) => r.id === repoRow.id);

    expect(matched?.linkedProjectId).toBe(proj.id);
    expect(matched?.localPath).toBe('C:\\projects\\hello-world');
  });
});
