import { describe, expect, it } from 'vitest';
import {
  GitHubClientIdSchema,
  GitHubConnectionDTOSchema,
  DeviceCodeStartDTOSchema,
  DeviceFlowPollDTOSchema,
  GitHubRepositoryDTOSchema,
  ListRepositoriesResponseSchema,
  CloneRepositoryRequestSchema,
  LinkRepositoryRequestSchema,
  normalizeGitHubRemoteUrl,
} from '../src/github.ts';

describe('GitHubClientIdSchema', () => {
  it('accepts valid GitHub App client IDs', () => {
    expect(GitHubClientIdSchema.safeParse('Iv1.1234567890abcdef').success).toBe(true);
    expect(GitHubClientIdSchema.safeParse('Iv23abcde12345678901').success).toBe(true);
    expect(GitHubClientIdSchema.safeParse('Iv1.aBcDeF_123-456').success).toBe(true);
  });

  it('rejects empty, too short, or invalid characters', () => {
    expect(GitHubClientIdSchema.safeParse('').success).toBe(false);
    expect(GitHubClientIdSchema.safeParse('abc').success).toBe(false);
    expect(GitHubClientIdSchema.safeParse('Iv1.with spaces').success).toBe(false);
    expect(GitHubClientIdSchema.safeParse('Iv1.with$bad*chars').success).toBe(false);
  });
});

describe('GitHubConnectionDTOSchema', () => {
  it('validates a complete GitHub connection DTO', () => {
    const raw = {
      id: 1,
      githubUserId: 123456,
      login: 'octocat',
      appClientId: 'Iv1.1234567890abcdef',
      status: 'connected',
      accessExpiresAt: '2026-10-23T04:00:00.000Z',
      refreshExpiresAt: '2027-04-23T04:00:00.000Z',
      grantedPermissions: { contents: 'write', pull_requests: 'write' },
      lastValidatedAt: '2026-10-22T12:00:00.000Z',
    };
    const parsed = GitHubConnectionDTOSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.login).toBe('octocat');
      expect(parsed.data.status).toBe('connected');
    }
  });

  it('allows nulls for optional timestamps and permissions', () => {
    const raw = {
      id: 2,
      githubUserId: 789,
      login: 'dev',
      appClientId: 'Iv1.1234567890abcdef',
      status: 'disconnected',
      accessExpiresAt: null,
      refreshExpiresAt: null,
      grantedPermissions: null,
      lastValidatedAt: null,
    };
    expect(GitHubConnectionDTOSchema.safeParse(raw).success).toBe(true);
  });
});

describe('DeviceCodeStartDTOSchema & DeviceFlowPollDTOSchema', () => {
  it('validates device code start payload', () => {
    const payload = {
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 899,
      interval: 5,
      sessionToken: 'sess_123456',
    };
    expect(DeviceCodeStartDTOSchema.safeParse(payload).success).toBe(true);
  });

  it('validates device poll states', () => {
    expect(DeviceFlowPollDTOSchema.safeParse({ status: 'pending' }).success).toBe(true);
    expect(DeviceFlowPollDTOSchema.safeParse({ status: 'slow_down', interval: 10 }).success).toBe(true);
    expect(DeviceFlowPollDTOSchema.safeParse({ status: 'expired', error: 'Code expired' }).success).toBe(true);
    expect(DeviceFlowPollDTOSchema.safeParse({ status: 'access_denied', error: 'User denied' }).success).toBe(true);
  });
});

describe('Repository browser & Clone contracts', () => {
  it('validates GitHubRepositoryDTO and ListRepositoriesResponse', () => {
    const repo = {
      id: 1,
      githubRepoId: 98765,
      owner: 'octocat',
      name: 'hello-world',
      fullName: 'octocat/hello-world',
      description: 'My first repo',
      defaultBranch: 'main',
      visibility: 'public' as const,
      permissions: { admin: true, push: true, pull: true },
      installationId: 456,
      localPath: null,
      linkedProjectId: null,
      lastSyncedAt: Date.now(),
    };
    expect(GitHubRepositoryDTOSchema.safeParse(repo).success).toBe(true);

    const listRes = {
      repositories: [repo],
      installations: [
        {
          id: 456,
          account: { login: 'octocat', type: 'User' as const },
          htmlUrl: 'https://github.com/settings/installations/456',
        },
      ],
      notices: [
        {
          org: 'acme-corp',
          type: 'install_needed' as const,
          url: 'https://github.com/apps/my-app/installations/new',
        },
      ],
      rateLimit: { remaining: 4999, reset: 1700000000 },
    };
    expect(ListRepositoriesResponseSchema.safeParse(listRes).success).toBe(true);
  });

  it('validates CloneRepositoryRequest and LinkRepositoryRequest', () => {
    expect(CloneRepositoryRequestSchema.safeParse({ parentDirectory: 'C:\\Users\\USER\\code' }).success).toBe(true);
    expect(CloneRepositoryRequestSchema.safeParse({ parentDirectory: 'C:\\Users\\USER\\code', projectKey: 'FOO', projectName: 'Foo' }).success).toBe(true);
    expect(CloneRepositoryRequestSchema.safeParse({ parentDirectory: '' }).success).toBe(false);
    expect(CloneRepositoryRequestSchema.safeParse({ parentDirectory: 'C:\\code', projectKey: 'bad key' }).success).toBe(false);

    expect(LinkRepositoryRequestSchema.safeParse({ localPath: 'C:\\code\\existing-repo' }).success).toBe(true);
    expect(LinkRepositoryRequestSchema.safeParse({ localPath: '' }).success).toBe(false);
  });
});

describe('normalizeGitHubRemoteUrl', () => {
  it('normalizes various GitHub HTTPS and SSH URLs to owner/repo', () => {
    expect(normalizeGitHubRemoteUrl('https://github.com/octocat/Hello-World.git')).toBe('octocat/hello-world');
    expect(normalizeGitHubRemoteUrl('https://github.com/octocat/Hello-World')).toBe('octocat/hello-world');
    expect(normalizeGitHubRemoteUrl('git@github.com:octocat/Hello-World.git')).toBe('octocat/hello-world');
    expect(normalizeGitHubRemoteUrl('ssh://git@github.com/octocat/Hello-World.git')).toBe('octocat/hello-world');
    expect(normalizeGitHubRemoteUrl('https://x-access-token:ghs_secret@github.com/octocat/Hello-World.git')).toBe('octocat/hello-world');
  });

  it('returns null for non-github URLs or malformed inputs', () => {
    expect(normalizeGitHubRemoteUrl('https://gitlab.com/octocat/Hello-World.git')).toBeNull();
    expect(normalizeGitHubRemoteUrl('https://bitbucket.org/octocat/Hello-World.git')).toBeNull();
    expect(normalizeGitHubRemoteUrl('not-a-url')).toBeNull();
    expect(normalizeGitHubRemoteUrl('')).toBeNull();
  });
});
