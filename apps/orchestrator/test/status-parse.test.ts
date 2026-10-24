// apps/orchestrator/test/status-parse.test.ts
import { describe, expect, it } from 'vitest';
import { parsePorcelainStatus } from '../src/git/status-parse.ts';

describe('parsePorcelainStatus (z-terminated porcelain v1 + --branch)', () => {
  it('parses branch header with upstream and ahead/behind', () => {
    const out = '## main...origin/main [ahead 2, behind 1]\0';
    const s = parsePorcelainStatus(out);
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, files: [] });
  });

  it('parses a branch without upstream; nulls ahead/behind', () => {
    const s = parsePorcelainStatus('## local-only\0');
    expect(s).toMatchObject({ branch: 'local-only', upstream: null, ahead: null, behind: null });
  });

  it('parses staged, unstaged, untracked, deleted and conflict entries', () => {
    const out = '## main\0A  new-file.ts\0 M dirty.ts\0?? stray.bin\0D  gone.ts\0UU both-want.md\0';
    const s = parsePorcelainStatus(out);
    expect(s.files).toEqual([
      { path: 'new-file.ts', x: 'A', y: ' ' },
      { path: 'dirty.ts', x: ' ', y: 'M' },
      { path: 'stray.bin', x: '?', y: '?' },
      { path: 'gone.ts', x: 'D', y: ' ' },
      { path: 'both-want.md', x: 'U', y: 'U' },
    ]);
  });

  it('consumes the rename original-path field and keeps the new path', () => {
    const out = '## main\0R  new-name.ts\0old-name.ts\0';
    const s = parsePorcelainStatus(out);
    expect(s.files).toEqual([{ path: 'new-name.ts', x: 'R', y: ' ' }]);
  });

  it('returns null branch on a detached HEAD', () => {
    const s = parsePorcelainStatus('## HEAD (no branch)\0');
    expect(s.branch).toBeNull();
    expect(s.upstream).toBeNull();
  });
});
