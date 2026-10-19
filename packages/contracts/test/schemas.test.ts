import { describe, expect, it } from 'vitest';
import {
  CreateStoryRequest, PatchProjectRequest, ProjectKey, ProjectSettings, Sha, StoryListQuery, TransitionRequest,
  defaultProjectSettings,
} from '../src/index.ts';

describe('Sha', () => {
  it('accepts 40- and 64-hex lowercase SHAs', () => {
    expect(Sha.safeParse('a'.repeat(40)).success).toBe(true);
    expect(Sha.safeParse('b'.repeat(64)).success).toBe(true);
  });
  it('rejects other lengths, uppercase and non-hex', () => {
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)]) {
      expect(Sha.safeParse(bad).success).toBe(false);
    }
  });
});

describe('ProjectSettings', () => {
  it('fills nested defaults from an empty object', () => {
    const s = defaultProjectSettings();
    expect(s.maxAttempts).toBe(3);
    expect(s.budgets).toEqual({ requestsPerRun: 300, requestsPerStory: 1000, inputTokensPerStory: 3_000_000 });
    expect(s.jobLimits).toEqual({ memoryMb: 4096, maxProcesses: 64 });
    expect(s.protectedPaths).toContain('.github/workflows/**');
    expect(s.publish).toBe(false);
    expect(s.allowPaid).toBe(false);
  });
  it('rejects unknown keys in a project patch', () => {
    expect(PatchProjectRequest.safeParse({ name: 'x', bogus: 1 }).success).toBe(false);
  });
  it('reserves the secrets check key for the internal scan', () => {
    const check = { key: 'secrets', command: 'npm test', mandatory: true, timeoutSec: 10 };
    expect(ProjectSettings.safeParse({ checks: [check] }).success).toBe(false);
    expect(ProjectSettings.safeParse({ checks: [{ ...check, key: 'test' }] }).success).toBe(true);
  });
});

describe('ProjectKey', () => {
  it('requires 2–10 uppercase letters/digits starting with a letter', () => {
    expect(ProjectKey.safeParse('INV').success).toBe(true);
    for (const bad of ['I', 'inv', '1NV', 'INVENTORY12']) expect(ProjectKey.safeParse(bad).success).toBe(false);
  });
});

describe('CreateStoryRequest', () => {
  it('applies defaults and trims', () => {
    const r = CreateStoryRequest.parse({ title: '  Inventory  ' });
    expect(r).toEqual({ title: 'Inventory', description: '', acceptanceCriteria: [], priority: 'P2', labels: [], dependsOn: [] });
  });
  it('is strict about unknown keys', () => {
    expect(CreateStoryRequest.safeParse({ title: 'x', status: 'DONE' }).success).toBe(false);
  });
});

describe('StoryListQuery', () => {
  it('defaults sort to rank', () => {
    expect(StoryListQuery.parse({}).sort).toBe('rank');
  });
});

describe('TransitionRequest', () => {
  it('parses each human event with expectedVersion', () => {
    expect(TransitionRequest.parse({ event: 'cancel', expectedVersion: 2 })).toEqual({ event: 'cancel', expectedVersion: 2 });
    expect(TransitionRequest.parse({ event: 'recover', target: 'resume', expectedVersion: 0 })).toMatchObject({ target: 'resume' });
    expect(TransitionRequest.parse({ event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 5 })).toMatchObject({ sha: 'a'.repeat(40) });
  });
  it('rejects missing expectedVersion, unknown events and bad payloads', () => {
    expect(TransitionRequest.safeParse({ event: 'cancel' }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'mark_done', expectedVersion: 1 }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'request_changes', sha: 'a'.repeat(40), findings: [], expectedVersion: 1 }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'recover', target: 'DONE', expectedVersion: 1 }).success).toBe(false);
  });
});
