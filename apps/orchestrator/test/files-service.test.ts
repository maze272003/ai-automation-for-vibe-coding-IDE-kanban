// apps/orchestrator/test/files-service.test.ts
import { TextEncoder } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@aik/contracts';
import { WorkspaceFileService } from '../src/files/service.ts';
import { ApiHttpError } from '../src/api/errors.ts';
import { ProjectService } from '../src/projects/service.ts';
import { systemClock } from '../src/time.ts';
import { createTestDb } from './helpers/db.ts';
import { assertInTemp, makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tracked = (d: string) => {
  tempDirs.push(d);
  return d;
};

async function setup(opts: { repo?: string; busy?: (id: number) => string | null } = {}) {
  const t = createTestDb();
  const repo = tracked(opts.repo ?? makeTempRepo({ name: 'code' }));
  assertInTemp(repo);
  const projects = new ProjectService({ db: t.db, now: systemClock });
  const svc = new WorkspaceFileService({ projects, ...(opts.busy ? { busy: opts.busy } : {}) });
  const project = await projects.create({ name: 'Code', key: 'CODE', repoPath: repo });
  return { t, repo, svc, projects, project };
}

const put = (repo: string, rel: string, content: string | Buffer) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (err: unknown) => (err instanceof ApiHttpError ? `${err.statusCode} ${err.code}` : String(err)),
  );

describe('WorkspaceFileService.tree', () => {
  it('lists the root with directories first, hides .git and normalizes paths', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'src/a.ts', 'a');
    put(repo, 'docs/readme.md', 'd');
    put(repo, 'zzz.txt', 'z');
    const tree = await svc.tree(project.id);
    expect(tree.path).toBe('');
    expect(tree.entries.map((e) => e.name)).toEqual(['docs', 'src', 'README.md', 'zzz.txt']);
    expect(tree.entries.find((e) => e.name === '.git')).toBeUndefined();
    expect(tree.entries.find((e) => e.name === 'src')).toMatchObject({ type: 'dir', size: null });
    expect(tree.entries.find((e) => e.name === 'README.md')).toMatchObject({ type: 'file', size: 7 });
  });

  it('lists one nested directory at a time', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'src/b.ts', 'b');
    put(repo, 'src/a.ts', 'a');
    put(repo, 'src/nested/c.ts', 'c');
    const tree = await svc.tree(project.id, 'src');
    expect(tree.path).toBe('src');
    expect(tree.entries.map((e) => e.path)).toEqual(['src/nested', 'src/a.ts', 'src/b.ts']);
  });

  it('rejects a file as the tree root and unsafe paths', async () => {
    const { svc, project } = await setup();
    expect(await code(svc.tree(project.id, 'README.md'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.tree(project.id, '../'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.tree(project.id, 'C:\\Windows'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.tree(project.id, 'missing'))).toBe('404 NOT_FOUND');
  });

  it('caps a directory at MAX_TREE_ENTRIES and reports truncation', async () => {
    const { repo, svc, project } = await setup();
    for (let i = 0; i < 1005; i += 1) fs.writeFileSync(path.join(repo, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const tree = await svc.tree(project.id);
    expect(tree.entries).toHaveLength(1000);
    expect(tree.truncated).toBe(true);
  });

  it('lists symlinks without traversing them', async (ctx) => {
    const { repo, svc, project } = await setup();
    const outside = makeJunction(repo);
    if (!outside) {
      ctx.skip();
      return;
    }
    const tree = await svc.tree(project.id);
    expect(tree.entries.find((e) => e.name === 'linked')).toMatchObject({ type: 'symlink', size: null });
    expect(await code(svc.tree(project.id, 'linked'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.read(project.id, 'linked/x.txt'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.write(project.id, { path: 'linked/x.txt', content: 'pwn', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
    expect(fs.readFileSync(path.join(outside, 'x.txt'), 'utf8')).toBe('outside');
  });

  it('hides in-progress atomic-write temp files', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, '.aik-pending.tmp'), 'scratch');
    const tree = await svc.tree(project.id);
    expect(tree.entries.some((e) => e.name.startsWith('.aik-'))).toBe(false);
  });
});

describe('WorkspaceFileService.read', () => {
  it('returns text, size and the SHA-256 of the full file', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'src/a.ts', 'export const a = 1;\n');
    const file = await svc.read(project.id, 'src/a.ts');
    expect(file).toMatchObject({ path: 'src/a.ts', size: 20, binary: false, truncated: false, editable: true });
    expect(file.content).toBe('export const a = 1;\n');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks NUL and invalid UTF-8 files as binary with no content/hash', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    fs.writeFileSync(path.join(repo, 'bad.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    for (const rel of ['bin.dat', 'bad.txt']) {
      const file = await svc.read(project.id, rel);
      expect(file).toMatchObject({ content: null, sha256: null, binary: true, editable: false });
    }
  });

  it('caps large files at MAX_FILE_BYTES and reports truncation', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    const file = await svc.read(project.id, 'big.txt');
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
    expect(file.editable).toBe(false);
    expect(file.sha256).toBeNull();
    expect(new TextEncoder().encode(file.content ?? '')).toHaveLength(MAX_FILE_BYTES);
  });

  it('reads exactly MAX_FILE_BYTES without truncation', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'exact.txt'), Buffer.alloc(MAX_FILE_BYTES, 0x61));
    const file = await svc.read(project.id, 'exact.txt');
    expect(file).toMatchObject({ truncated: false, binary: false, editable: true });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextEncoder().encode(file.content ?? '')).toHaveLength(MAX_FILE_BYTES);
  });

  it('does not emit a replacement character when truncation splits UTF-8', async () => {
    const { repo, svc, project } = await setup();
    const bytes = Buffer.concat([Buffer.alloc(MAX_FILE_BYTES - 1, 0x61), Buffer.from('é', 'utf8')]);
    expect(bytes).toHaveLength(MAX_FILE_BYTES + 1);
    fs.writeFileSync(path.join(repo, 'split.txt'), bytes);
    const file = await svc.read(project.id, 'split.txt');
    expect(file.truncated).toBe(true);
    expect(file.content).not.toContain('\uFFFD');
    expect(file.editable).toBe(false);
  });

  it('marks UTF-16 BOM files as non-editable binary instead of rewriting them as UTF-8', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
    const file = await svc.read(project.id, 'utf16.txt');
    expect(file).toMatchObject({ content: null, sha256: null, binary: true, editable: false });
  });

  it('rejects directories, git internals, missing files and unsafe paths', async () => {
    const { repo, svc, project } = await setup();
    fs.mkdirSync(path.join(repo, 'dir'));
    expect(await code(svc.read(project.id, 'dir'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.read(project.id, '.git/config'))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.read(project.id, 'missing.txt'))).toBe('404 NOT_FOUND');
    expect(await code(svc.read(project.id, '../../etc/passwd'))).toBe('400 VALIDATION_FAILED');
  });
});

describe('WorkspaceFileService.search', () => {
  it('finds literal matches, is case-insensitive by default and skips ignored/binary files', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'src/a.ts', 'const needle = 1;\n// Needle here\n');
    put(repo, 'src/b.txt', 'nothing');
    put(repo, 'node_modules/pkg/x.ts', 'needle');
    put(repo, 'dist/out.js', 'needle');
    put(repo, 'bin.dat', Buffer.concat([Buffer.from([0, 1]), Buffer.from('needle')]));
    put(repo, '.git/config', 'needle');
    const result = await svc.search(project.id, 'needle');
    expect(result.matches.map((m) => `${m.path}:${m.line}:${m.column}`)).toEqual(['src/a.ts:1:7', 'src/a.ts:2:4']);
    expect(result.matches[1]!.preview).toBe('// Needle here');
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('honours case sensitivity and result limits', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'a.txt', 'Needle\nneedle\n');
    const sensitive = await svc.search(project.id, 'Needle', { caseSensitive: true });
    expect(sensitive.matches.map((m) => m.line)).toEqual([1]);
    const limited = await svc.search(project.id, 'needle', { limit: 1 });
    expect(limited.matches).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(await code(svc.search(project.id, '   '))).toBe('400 VALIDATION_FAILED');
  });

  it('skips files larger than the search cap', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'large.txt', `${'x'.repeat(1024 * 1024)}needle`);
    const result = await svc.search(project.id, 'needle');
    expect(result.matches).toEqual([]);
  });

  it('does not follow symlinked directories or files', async (ctx) => {
    const { repo, svc, project } = await setup();
    put(repo, 'src/a.ts', 'needle');
    const outside = makeJunction(repo);
    if (!outside) {
      ctx.skip();
      return;
    }
    fs.writeFileSync(path.join(outside, 'x.txt'), 'needle outside');
    const result = await svc.search(project.id, 'needle');
    expect(result.matches.map((m) => m.path)).toEqual(['src/a.ts']);
  });

  it('reports columns against the original text when case folding changes length', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'unicode.txt', 'okİ x needle\n');
    const result = await svc.search(project.id, 'needle');
    expect(result.matches[0]).toMatchObject({ line: 1, column: 7 });
  });
});

describe('WorkspaceFileService.write', () => {
  it('creates a new file and updates it with the expected hash', async () => {
    const { repo, svc, project } = await setup();
    fs.mkdirSync(path.join(repo, 'notes'));
    const created = await svc.write(project.id, { path: 'notes/new.txt', content: 'one', expectedSha256: null });
    expect(created).toMatchObject({ projectId: project.id, path: 'notes/new.txt', size: 3 });
    expect(fs.readFileSync(path.join(repo, 'notes/new.txt'), 'utf8')).toBe('one');
    const updated = await svc.write(project.id, { path: 'notes/new.txt', content: 'two', expectedSha256: created.sha256 });
    expect(updated.sha256).not.toBe(created.sha256);
    expect(fs.readFileSync(path.join(repo, 'notes/new.txt'), 'utf8')).toBe('two');
  });

  it('refuses stale hashes and create-over-existing conflicts with FILE_CHANGED', async () => {
    const { repo, svc, project } = await setup();
    put(repo, 'a.txt', 'current');
    expect(await code(svc.write(project.id, { path: 'a.txt', content: 'x', expectedSha256: null }))).toBe('409 FILE_CHANGED');
    expect(await code(svc.write(project.id, { path: 'a.txt', content: 'x', expectedSha256: 'a'.repeat(64) }))).toBe('409 FILE_CHANGED');
    expect(await code(svc.write(project.id, { path: 'missing.txt', content: 'x', expectedSha256: 'a'.repeat(64) }))).toBe('409 FILE_CHANGED');
  });

  it('refuses writes while the project is busy', async () => {
    const { svc, project } = await setup({ busy: () => 'An agent run is active' });
    expect(await code(svc.write(project.id, { path: 'a.txt', content: 'x', expectedSha256: null }))).toBe('409 PROJECT_BUSY');
  });

  it('enforces the byte cap and the path policy', async () => {
    const { repo, svc, project } = await setup();
    expect(await code(svc.write(project.id, { path: 'big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1), expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
    fs.mkdirSync(path.join(repo, 'dir'));
    expect(await code(svc.write(project.id, { path: '../escape.txt', content: 'x', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.write(project.id, { path: 'dir', content: 'x', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.write(project.id, { path: 'missing/child.txt', content: 'x', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
    expect(await code(svc.write(project.id, { path: '.git/config', content: 'x', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
  });

  it('leaves no temporary files behind and preserves file mode semantics', async () => {
    const { repo, svc, project } = await setup();
    await svc.write(project.id, { path: 'a.txt', content: 'atomic', expectedSha256: null });
    expect(fs.readdirSync(repo).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('atomic');
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(repo, 'a.txt'), 0o755);
      const current = await svc.read(project.id, 'a.txt');
      await svc.write(project.id, { path: 'a.txt', content: 'atomic2', expectedSha256: current.sha256 });
      expect(fs.statSync(path.join(repo, 'a.txt')).mode & 0o777).toBe(0o755);
    }
  });

  it('serializes concurrent saves based on the same hash', async () => {
    const { svc, project } = await setup();
    const created = await svc.write(project.id, { path: 'race.txt', content: 'start', expectedSha256: null });
    const results = await Promise.allSettled([
      svc.write(project.id, { path: 'race.txt', content: 'first', expectedSha256: created.sha256 }),
      svc.write(project.id, { path: 'race.txt', content: 'second', expectedSha256: created.sha256 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ApiHttpError);
    expect((rejected?.reason as ApiHttpError).code).toBe('FILE_CHANGED');
  });

  it('accepts exactly MAX_FILE_BYTES and rejects NUL content', async () => {
    const { repo, svc, project } = await setup();
    const saved = await svc.write(project.id, { path: 'exact.txt', content: 'x'.repeat(MAX_FILE_BYTES), expectedSha256: null });
    expect(saved.size).toBe(MAX_FILE_BYTES);
    expect(fs.statSync(path.join(repo, 'exact.txt')).size).toBe(MAX_FILE_BYTES);
    expect(await code(svc.write(project.id, { path: 'nul.txt', content: 'a\0b', expectedSha256: null }))).toBe('400 VALIDATION_FAILED');
  });
});

/** Creates a directory junction inside the repo; returns null when the OS refuses. */
function makeJunction(repo: string): string | null {
  const outside = tracked(fs.mkdtempSync(path.join(path.dirname(repo), 'aikanban-outside-')));
  fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction');
    return outside;
  } catch {
    return null;
  }
}
