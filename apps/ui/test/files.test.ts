// apps/ui/test/files.test.ts
import { describe, expect, it } from 'vitest';
import {
  baseName,
  fileExtension,
  formatMatchLocation,
  joinRepoPath,
  languageForPath,
  normalizeRepoPath,
  parentPath,
  searchPreview,
} from '../src/lib/files.ts';

describe('repo path helpers', () => {
  it('normalizes separators and edge slashes', () => {
    expect(normalizeRepoPath('src\\lib\\a.ts')).toBe('src/lib/a.ts');
    expect(normalizeRepoPath('/src/a.ts/')).toBe('src/a.ts');
    expect(normalizeRepoPath('')).toBe('');
  });

  it('splits parents and basenames', () => {
    expect(parentPath('src/lib/a.ts')).toBe('src/lib');
    expect(parentPath('README.md')).toBe('');
    expect(baseName('src/lib/a.ts')).toBe('a.ts');
    expect(baseName('README.md')).toBe('README.md');
    expect(joinRepoPath('', 'a.ts')).toBe('a.ts');
    expect(joinRepoPath('src', 'a.ts')).toBe('src/a.ts');
    expect(joinRepoPath('src\\lib', 'a.ts')).toBe('src/lib/a.ts');
  });
});

describe('languageForPath', () => {
  it('maps common extensions to Monaco language ids', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript');
    expect(languageForPath('src/a.tsx')).toBe('typescript');
    expect(languageForPath('src/a.jsx')).toBe('javascript');
    expect(languageForPath('package.json')).toBe('json');
    expect(languageForPath('styles/site.scss')).toBe('scss');
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('scripts/run.sh')).toBe('shell');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('unknown.zzz')).toBe('plaintext');
    expect(languageForPath('.gitignore')).toBe('plaintext');
  });

  it('exposes the lowercase extension', () => {
    expect(fileExtension('SRC/App.TSX')).toBe('tsx');
    expect(fileExtension('Makefile')).toBe('');
  });
});

describe('searchPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(searchPreview('  const   value\t= 1  ')).toBe('const value = 1');
  });

  it('clips long previews with an ellipsis', () => {
    const preview = searchPreview('a'.repeat(200), 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('formatMatchLocation', () => {
  it('renders path:line:column', () => {
    expect(formatMatchLocation('src/a.ts', 3, 7)).toBe('src/a.ts:3:7');
  });
});
