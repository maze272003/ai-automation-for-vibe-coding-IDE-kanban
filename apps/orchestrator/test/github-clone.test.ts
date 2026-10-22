import { githubConnections, remoteSyncRuns, repositoryConnections } from '@aik/db';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { GitHubRepositoryService } from '../src/github/repository-service.ts';
import { GitHubCloneService } from '../src/github/clone-service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('GitHubCloneService', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let authService: GitHubAuthService;
  let repoService: GitHubRepositoryService;
  let projectService: ProjectService;
  let cloneService: GitHubCloneService;
  let credentialStore: MemoryCredentialStore;
  let repoConnId: number;

  beforeAll(async () => {
    dbHolder = createTestDb();
    credentialStore = new MemoryCredentialStore();

    authService = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
    });

    repoService = new GitHubRepositoryService({
      db: dbHolder.db,
      authService,
    });

    projectService = new ProjectService({
      db: dbHolder.db,
    });

    // Mock clone runner to avoid external network calls during unit test
    cloneService = new GitHubCloneService({
      db: dbHolder.db,
      authService,
      repoService,
      projectService,
      gitCloneRunner: async (_url, targetPath) => {
        fs.mkdirSync(targetPath, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: targetPath });
        fs.writeFileSync(path.join(targetPath, 'README.md'), '# Cloned Repo\n');
        execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.'], { cwd: targetPath });
        execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial commit'], { cwd: targetPath });
      },
    });

    // Seed active GitHub connection and repository_connection
    const now = new Date();
    const conn = dbHolder.db
      .insert(githubConnections)
      .values({
        githubUserId: 12345,
        login: 'testuser',
        appClientId: 'Iv1.testclientid',
        tokenRef: 'AiKanban/github/12345',
        status: 'connected',
        accessExpiresAt: new Date(now.getTime() + 8 * 3600 * 1000),
        refreshExpiresAt: new Date(now.getTime() + 180 * 86400 * 1000),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    await credentialStore.saveTokens(12345, {
      accessToken: 'gho_active_test_token',
      refreshToken: 'ghr_active_refresh_token',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: now.getTime(),
      expiresIn: 28800,
      refreshTokenExpiresIn: 15552000,
    });

    const repo = dbHolder.db
      .insert(repositoryConnections)
      .values({
        githubConnectionId: conn.id,
        githubRepoId: 998877,
        owner: 'testuser',
        name: 'sample-project',
        defaultBranch: 'main',
        visibility: 'public',
        permissions: { admin: true, push: true, pull: true },
        lastSyncedAt: now,
      })
      .returning()
      .get();

    repoConnId = repo.id;
  });

  afterAll(() => {
    dbHolder.close();
  });

  describe('cloneRepository', () => {
    it('refuses clone when target directory exists and is not empty', async () => {
      const parent = makeTempDir('aik-clone-parent-');
      const target = path.join(parent, 'sample-project');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'existing-file.txt'), 'occupied');

      await expect(
        cloneService.cloneRepository(repoConnId, { parentDirectory: parent })
      ).rejects.toThrow('Target directory already exists and is not empty');
    });

    it('clones repository, creates project, updates localPath, and audits sync run', async () => {
      const parent = makeTempDir('aik-clone-parent-');
      const project = await cloneService.cloneRepository(repoConnId, {
        parentDirectory: parent,
        projectKey: 'SAMPLE',
        projectName: 'Sample Project',
      });

      expect(project.key).toBe('SAMPLE');
      expect(project.name).toBe('Sample Project');
      expect(fs.existsSync(path.join(project.repoPath, 'README.md'))).toBe(true);

      // Verify repository connection has localPath set
      const updatedRepo = dbHolder.db
        .select()
        .from(repositoryConnections)
        .where(eq(repositoryConnections.id, repoConnId))
        .get();
      expect(updatedRepo?.localPath).toBe(project.repoPath);

      // Verify remote_sync_runs audit row
      const runs = dbHolder.db.select().from(remoteSyncRuns).all();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.kind).toBe('clone');
      expect(runs[0]?.status).toBe('succeeded');
    });
  });

  describe('linkRepository', () => {
    it('refuses link when remote URL does not match repository', async () => {
      const localRepo = makeTempRepo({ name: 'other-repo' });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/someone-else/different-repo.git'], { cwd: localRepo });

      await expect(
        cloneService.linkRepository(repoConnId, { localPath: localRepo })
      ).rejects.toThrow('Remote URL mismatch');
    });

    it('links existing clone when normalized remote URL matches', async () => {
      const localRepo = makeTempRepo({ name: 'matching-repo' });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:testuser/sample-project.git'], { cwd: localRepo });

      const res = await cloneService.linkRepository(repoConnId, {
        localPath: localRepo,
        projectKey: 'LINKED',
        projectName: 'Linked Sample',
      });

      expect(res.project.key).toBe('LINKED');
      expect(res.project.repoPath.toLowerCase()).toBe(localRepo.toLowerCase());
      expect(res.repository.localPath?.toLowerCase()).toBe(localRepo.toLowerCase());
      expect(res.repository.linkedProjectId).toBe(res.project.id);
    });
  });
});
