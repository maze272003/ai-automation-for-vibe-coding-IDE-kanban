// apps/ui/test/merge-ack.test.ts
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.ts';
import { approveMergeBody, canApproveMerge, isProtectedPathsGuardError } from '../src/lib/merge-ack.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const story = { candidateSha: SHA, statusVersion: 5 };

const guardError = (...guards: { guard: string; reason: string }[]) =>
  new ApiRequestError(409, { error: { code: 'GUARD_FAILED', message: 'guard failed', retryable: false, failedGuards: guards } });

describe('approveMergeBody', () => {
  it('omits acknowledgedProtectedPaths when the candidate touched no protected paths', () => {
    const body = approveMergeBody(story, [], true, '');
    expect(body).toEqual({ event: 'approve_merge', sha: SHA, expectedVersion: 5 });
    expect(body).not.toHaveProperty('acknowledgedProtectedPaths');
  });

  it('includes the protected paths as acknowledged when there are any', () => {
    expect(approveMergeBody(story, ['.github/workflows/ci.yml', 'docs/CHANGELOG.md'], true, '')).toEqual({
      event: 'approve_merge',
      sha: SHA,
      expectedVersion: 5,
      acknowledgedProtectedPaths: ['.github/workflows/ci.yml', 'docs/CHANGELOG.md'],
    });
  });

  it('omits a blank note and includes a non-blank note trimmed', () => {
    expect(approveMergeBody(story, [], true, '   ')).not.toHaveProperty('note');
    expect(approveMergeBody(story, [], true, '  checked them  ')).toMatchObject({ note: 'checked them' });
  });
});

describe('canApproveMerge', () => {
  it('allows merging without protected paths even when nothing was acknowledged', () => {
    expect(canApproveMerge([], false)).toBe(true);
  });

  it('blocks merging while protected paths are unacknowledged', () => {
    expect(canApproveMerge(['.github/workflows/ci.yml'], false)).toBe(false);
  });

  it('allows merging protected paths once acknowledged', () => {
    expect(canApproveMerge(['.github/workflows/ci.yml'], true)).toBe(true);
  });
});

describe('isProtectedPathsGuardError', () => {
  it('matches an ApiRequestError carrying the protected_paths_acknowledged guard', () => {
    expect(isProtectedPathsGuardError(guardError({ guard: 'protected_paths_acknowledged', reason: 'Acknowledge the protected paths' }))).toBe(true);
    expect(
      isProtectedPathsGuardError(guardError({ guard: 'merge_window', reason: 'x' }, { guard: 'protected_paths_acknowledged', reason: 'y' })),
    ).toBe(true);
  });

  it('rejects other guards and non-ApiRequestError values', () => {
    expect(isProtectedPathsGuardError(guardError({ guard: 'merge_window', reason: 'x' }))).toBe(false);
    expect(isProtectedPathsGuardError(new Error('plain'))).toBe(false);
    expect(isProtectedPathsGuardError('not an error')).toBe(false);
  });
});
