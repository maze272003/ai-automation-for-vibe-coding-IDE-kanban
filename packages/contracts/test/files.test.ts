// packages/contracts/test/files.test.ts
import { describe, expect, it } from 'vitest';
import {
  FileContentDTO,
  FileSearchDTO,
  FileTreeDTO,
  FileWriteRequest,
  MAX_FILE_BYTES,
  RepoRelPath,
  isRepoRelPath,
} from '../src/index.ts';

describe('RepoRelPath', () => {
  it('accepts repo-relative POSIX and Windows separator paths', () => {
    for (const good of ['src/a.ts', 'docs/x y.md', 'a\\b\\c.ts', '.gitignore', 'a-b_c.1', 'src/.env.local']) {
      expect(RepoRelPath.safeParse(good).success, good).toBe(true);
      expect(isRepoRelPath(good), good).toBe(true);
    }
  });

  it('rejects traversal, absolute, drive/UNC, NUL and reserved forms', () => {
    const bad = [
      '', '/etc/passwd', 'C:\\Windows', '\\\\server\\share', 'a/../b', 'a/./b', 'a//b',
      'a/.git/config', '.GIT/config', 'a\0b', 'a.', 'a ', 'con.txt', 'lpt9.log', 'a|b',
      'a:b', 'a<b', 'a?b', 'a*b', 'a"b', 'a\u007fb', 'a\u009fb', 'a\u202eb',
      'CONIN$', 'CONOUT$', 'CLOCK$', 'COM\u00b9', 'LPT\u00b3.txt',
    ];
    for (const value of bad) expect(isRepoRelPath(value), value).toBe(false);
  });

  it('caps length at 2000 characters', () => {
    expect(RepoRelPath.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(RepoRelPath.safeParse('a'.repeat(2001)).success).toBe(false);
  });
});

describe('FileWriteRequest', () => {
  it('accepts a full save request and rejects unknown keys', () => {
    const ok = { path: 'src/a.ts', content: 'x', expectedSha256: 'a'.repeat(64) };
    expect(FileWriteRequest.safeParse(ok).success).toBe(true);
    expect(FileWriteRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('allows null expectedSha256 for a create-only save', () => {
    expect(FileWriteRequest.safeParse({ path: 'a.txt', content: '', expectedSha256: null }).success).toBe(true);
  });

  it('caps content by UTF-8 bytes and validates the hash', () => {
    const base = { path: 'a.txt', expectedSha256: null };
    expect(FileWriteRequest.safeParse({ ...base, content: 'x'.repeat(MAX_FILE_BYTES) }).success).toBe(true);
    expect(FileWriteRequest.safeParse({ ...base, content: 'x'.repeat(MAX_FILE_BYTES + 1) }).success).toBe(false);
    // Fits the character cap but is 2 bytes per character.
    expect(FileWriteRequest.safeParse({ ...base, content: 'é'.repeat(MAX_FILE_BYTES / 2 + 1) }).success).toBe(false);
    expect(FileWriteRequest.safeParse({ ...base, content: 'x', expectedSha256: 'nope' }).success).toBe(false);
  });

  it('rejects binary and malformed UTF-16 content', () => {
    const base = { path: 'a.txt', expectedSha256: null };
    expect(FileWriteRequest.safeParse({ ...base, content: 'a\0b' }).success).toBe(false);
    expect(FileWriteRequest.safeParse({ ...base, content: '\ud800' }).success).toBe(false);
    expect(FileWriteRequest.safeParse({ ...base, content: 'ok' }).success).toBe(true);
  });
});

describe('file DTOs', () => {
  it('parses a tree response', () => {
    const dto = {
      projectId: 1,
      path: 'src',
      entries: [
        { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 },
        { name: 'nested', path: 'src/nested', type: 'dir', size: null },
      ],
      truncated: false,
    };
    expect(FileTreeDTO.parse(dto)).toEqual(dto);
    expect(FileTreeDTO.safeParse({ ...dto, entries: [{ ...dto.entries[0], type: 'socket' }] }).success).toBe(false);
    expect(FileTreeDTO.safeParse({ ...dto, path: '' }).success).toBe(true);
    expect(FileTreeDTO.safeParse({ ...dto, path: '../x' }).success).toBe(false);
    expect(FileTreeDTO.safeParse({ ...dto, entries: [{ ...dto.entries[0], name: 'a/b' }] }).success).toBe(false);
  });

  it('parses binary/truncated content with a null hash and content', () => {
    const dto = {
      projectId: 1, path: 'bin.dat', content: null, sha256: null, size: 10,
      binary: true, truncated: false, editable: false,
    };
    expect(FileContentDTO.parse(dto)).toEqual(dto);
  });

  it('parses a search response', () => {
    const dto = {
      projectId: 1, query: 'needle', caseSensitive: false, truncated: true, filesScanned: 4,
      matches: [{ path: 'src/a.ts', line: 2, column: 3, preview: 'needle here' }],
    };
    expect(FileSearchDTO.parse(dto)).toEqual(dto);
  });
});
