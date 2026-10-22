import { describe, expect, it } from 'vitest';
import {
  MemoryCredentialStore,
  type GitHubStoredTokens,
} from '../src/github/credentials.ts';

describe('MemoryCredentialStore', () => {
  it('saves, loads, and deletes tokens isolated by userId', async () => {
    const store = new MemoryCredentialStore();
    const tokens1: GitHubStoredTokens = {
      accessToken: 'ghu_access_token_user_1',
      refreshToken: 'ghr_refresh_token_user_1',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: Date.now(),
      expiresIn: 28800,
      refreshTokenExpiresIn: 15552000,
    };
    const tokens2: GitHubStoredTokens = {
      accessToken: 'ghu_access_token_user_2',
      refreshToken: 'ghr_refresh_token_user_2',
      tokenType: 'bearer',
      scope: 'repo',
      obtainedAt: Date.now(),
      expiresIn: 28800,
      refreshTokenExpiresIn: 15552000,
    };

    await store.saveTokens(101, tokens1);
    await store.saveTokens(102, tokens2);

    expect(await store.loadTokens(101)).toEqual(tokens1);
    expect(await store.loadTokens(102)).toEqual(tokens2);
    expect(await store.loadTokens(999)).toBeNull();

    await store.deleteTokens(101);
    expect(await store.loadTokens(101)).toBeNull();
    expect(await store.loadTokens(102)).toEqual(tokens2);
  });
});
