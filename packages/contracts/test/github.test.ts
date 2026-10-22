import { describe, expect, it } from 'vitest';
import {
  GitHubClientIdSchema,
  GitHubConnectionDTOSchema,
  DeviceCodeStartDTOSchema,
  DeviceFlowPollDTOSchema,
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
