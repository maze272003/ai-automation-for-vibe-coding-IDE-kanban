import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { detectChecks } from '../src/checks/detect.ts';
import { findProtectedPaths, matchesGlob } from '../src/git/protected.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const writeJson = (dir: string, value: unknown) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(value, null, 2));

describe('detectChecks', () => {
  test('proposes npm scripts for a Node repository without a lockfile', () => {
    const repo = makeTempRepo({ name: 'detect-npm' });
    writeJson(repo, { scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } });

    const detection = detectChecks(repo);

    expect(detection.ecosystems).toEqual(['node']);
    expect(detection.checks).toEqual([
      expect.objectContaining({ key: 'test', command: 'npm test', mandatory: true, source: 'npm script "test"' }),
      expect.objectContaining({ key: 'lint', command: 'npm run lint', mandatory: true }),
      expect.objectContaining({ key: 'typecheck', command: 'npm run typecheck', mandatory: true }),
    ]);
    expect(detection.warnings).toEqual([]);
  });

  test('honours packageManager and lockfiles for pnpm and yarn', () => {
    const pnpm = makeTempRepo({ name: 'detect-pnpm' });
    writeJson(pnpm, { packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest' } });
    expect(detectChecks(pnpm).checks[0]).toMatchObject({ key: 'test', command: 'pnpm test', source: 'pnpm script "test"' });

    const yarn = makeTempRepo({ name: 'detect-yarn' });
    writeJson(yarn, { scripts: { test: 'vitest', lint: 'eslint .' } });
    fs.writeFileSync(path.join(yarn, 'yarn.lock'), '');
    expect(detectChecks(yarn).checks.map((c) => c.command)).toEqual(['yarn test', 'yarn run lint']);

    const lockOnly = makeTempRepo({ name: 'detect-pnpm-lock' });
    writeJson(lockOnly, { scripts: { test: 'vitest' } });
    fs.writeFileSync(path.join(lockOnly, 'pnpm-lock.yaml'), '');
    expect(detectChecks(lockOnly).checks[0]?.command).toBe('pnpm test');
  });

  test('proposes the Python runner selected by lockfiles', () => {
    const uv = makeTempRepo({ name: 'detect-uv' });
    fs.writeFileSync(path.join(uv, 'pyproject.toml'), '[project]\nname = "x"\n');
    fs.writeFileSync(path.join(uv, 'uv.lock'), '');
    expect(detectChecks(uv)).toMatchObject({ ecosystems: ['python'], checks: [{ key: 'pytest', command: 'uv run pytest -q', source: 'uv.lock' }] });

    const poetry = makeTempRepo({ name: 'detect-poetry' });
    fs.writeFileSync(path.join(poetry, 'pyproject.toml'), '[tool.poetry]\n');
    fs.writeFileSync(path.join(poetry, 'poetry.lock'), '');
    expect(detectChecks(poetry).checks[0]?.command).toBe('poetry run pytest -q');

    const pip = makeTempRepo({ name: 'detect-pip' });
    fs.writeFileSync(path.join(pip, 'requirements.txt'), 'pytest\n');
    expect(detectChecks(pip).checks[0]).toMatchObject({ command: 'python -m pytest -q', source: 'requirements.txt' });
  });

  test('warns when nothing is detectable so secrets-only acceptance is explicit', () => {
    const detection = detectChecks(makeTempDir('aikanban-detect-empty-'));
    expect(detection.checks).toEqual([]);
    expect(detection.ecosystems).toEqual([]);
    expect(detection.warnings.join(' ')).toMatch(/secretsOnlyVerification/);
  });
});

describe('protected paths', () => {
  test('matches ** across directories and * within one segment', () => {
    expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true);
    expect(matchesGlob('deep/.github/workflows/ci.yml', '.github/workflows/**')).toBe(false);
    expect(matchesGlob('opencode.jsonc', 'opencode.json*')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/a.js', 'src/**/*.ts')).toBe(false);
    expect(matchesGlob('.gitmodules', '.git*')).toBe(true);
  });

  test('flags each protected file once, with forward slashes', () => {
    const flagged = findProtectedPaths(
      ['.github/workflows/ci.yml', 'src/a.ts', '.github/workflows/ci.yml', '.husky/pre-commit', 'README.md'],
      ['.github/workflows/**', '.husky/**', '.git*'],
    );
    expect(flagged).toEqual(['.github/workflows/ci.yml', '.husky/pre-commit']);
  });
});
