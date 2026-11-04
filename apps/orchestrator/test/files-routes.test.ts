// apps/orchestrator/test/files-routes.test.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@aik/contracts';
import { buildTestApp } from './helpers/app.ts';
import { assertInTemp, makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tracked = (d: string) => {
  tempDirs.push(d);
  return d;
};

const put = (repo: string, rel: string, content: string | Buffer) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

async function setup(opts: { fakeBusy?: (id: number) => string | null } = {}) {
  const repo = tracked(makeTempRepo({ name: 'code-routes' }));
  assertInTemp(repo);
  const built = await buildTestApp(opts);
  const created = await built.inject('POST', '/projects', { name: 'Code Routes', key: 'CRT', repoPath: repo });
  expect(created.statusCode).toBe(201);
  const project = created.json() as { id: number };
  return { ...built, repo, project };
}

describe('file routes', () => {
  it('lists the tree and reads file content', async () => {
    const { repo, inject, project } = await setup();
    put(repo, 'src/a.ts', 'export const a = 1;\n');
    const tree = await inject('GET', `/projects/${project.id}/files/tree`);
    expect(tree.statusCode).toBe(200);
    const treeBody = tree.json() as { path: string; entries: Array<{ path: string; type: string }> };
    expect(treeBody.path).toBe('');
    expect(treeBody.entries.some((e) => e.path === 'src' && e.type === 'dir')).toBe(true);
    expect(treeBody.entries.some((e) => e.path === '.git')).toBe(false);

    const nested = await inject('GET', `/projects/${project.id}/files/tree?path=src`);
    expect((nested.json() as { entries: Array<{ path: string }> }).entries.map((e) => e.path)).toEqual(['src/a.ts']);

    const content = await inject('GET', `/projects/${project.id}/files/content?path=src%2Fa.ts`);
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({ projectId: project.id, path: 'src/a.ts', content: 'export const a = 1;\n', binary: false, editable: true });
  });

  it('searches with literal case sensitivity and validates query values', async () => {
    const { repo, inject, project } = await setup();
    put(repo, 'a.txt', 'Needle\nneedle\n');
    const insensitive = await inject('GET', `/projects/${project.id}/files/search?q=needle`);
    expect(insensitive.statusCode).toBe(200);
    expect((insensitive.json() as { matches: unknown[] }).matches).toHaveLength(2);

    const sensitive = await inject('GET', `/projects/${project.id}/files/search?q=Needle&caseSensitive=true`);
    expect((sensitive.json() as { matches: Array<{ line: number }> }).matches.map((m) => m.line)).toEqual([1]);

    expect((await inject('GET', `/projects/${project.id}/files/search?q=`)).statusCode).toBe(400);
    expect((await inject('GET', `/projects/${project.id}/files/search?q=x&caseSensitive=yes`)).statusCode).toBe(400);
    expect((await inject('GET', `/projects/${project.id}/files/search?q=x&limit=0`)).statusCode).toBe(400);
    expect((await inject('GET', `/projects/${project.id}/files/search?q=x&limit=501`)).statusCode).toBe(400);
    const explicitFalse = await inject('GET', `/projects/${project.id}/files/search?q=needle&caseSensitive=false`);
    expect((explicitFalse.json() as { matches: unknown[] }).matches).toHaveLength(2);
  });

  it('writes a file, replays idempotently and reports stale SHA conflicts', async () => {
    const { repo, inject, project } = await setup();
    const key = crypto.randomUUID();
    const body = { path: 'notes.txt', content: 'hello', expectedSha256: null };
    const saved = await inject('PUT', `/projects/${project.id}/files/content`, body, key);
    expect(saved.statusCode).toBe(200);
    const savedBody = saved.json() as { sha256: string; size: number };
    expect(savedBody.size).toBe(5);
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('hello');

    const replay = await inject('PUT', `/projects/${project.id}/files/content`, body, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(savedBody);

    const stale = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'notes.txt', content: 'x', expectedSha256: 'a'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('FILE_CHANGED');
  });

  it('accepts a save above the old 1 MiB body limit and rejects content over the cap', async () => {
    const { repo, inject, project } = await setup();
    const content = 'x'.repeat(MAX_FILE_BYTES * 3 / 4);
    const saved = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'large.txt', content, expectedSha256: null });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { size: number }).size).toBe(content.length);
    expect(fs.statSync(path.join(repo, 'large.txt')).size).toBe(content.length);

    const tooLarge = await inject('PUT', `/projects/${project.id}/files/content`, {
      path: 'too-large.txt',
      content: 'x'.repeat(MAX_FILE_BYTES + 1),
      expectedSha256: null,
    });
    expect(tooLarge.statusCode).toBe(400);
    expect((tooLarge.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(fs.existsSync(path.join(repo, 'too-large.txt'))).toBe(false);
  });

  it('rejects binary content and mismatched idempotency replays', async () => {
    const { repo, inject, project } = await setup();
    const key = crypto.randomUUID();
    const first = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'a.txt', content: 'one', expectedSha256: null }, key);
    expect(first.statusCode).toBe(200);
    const mismatch = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'b.txt', content: 'two', expectedSha256: null }, key);
    expect(mismatch.statusCode).toBe(422);
    expect((mismatch.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);

    const binary = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'bin.txt', content: 'a\0b', expectedSha256: null });
    expect(binary.statusCode).toBe(400);
  });

  it('replays concurrent same-key saves exactly once', async () => {
    const { inject, project } = await setup();
    const key = crypto.randomUUID();
    const body = { path: 'once.txt', content: 'once', expectedSha256: null };
    const [a, b] = await Promise.all([
      inject('PUT', `/projects/${project.id}/files/content`, body, key),
      inject('PUT', `/projects/${project.id}/files/content`, body, key),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json()).toEqual(b.json());
  });

  it('requires an idempotency key on PUT', async () => {
    const { app, project } = await setup();
    const res = await app.inject({
      method: 'PUT',
      url: `/projects/${project.id}/files/content`,
      payload: { path: 'a.txt', content: 'x', expectedSha256: null },
      headers: { host: '127.0.0.1:41236', authorization: `Bearer ${'k'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/Idempotency-Key/i);
  });

  it('rejects writes while the project is busy, but not reads', async () => {
    const { repo, inject, project } = await setup({ fakeBusy: () => 'An agent run is active' });
    put(repo, 'a.txt', 'x');
    expect((await inject('GET', `/projects/${project.id}/files/tree`)).statusCode).toBe(200);
    const res = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'a.txt', content: 'y', expectedSha256: null });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PROJECT_BUSY');
  });

  it('rejects unsafe paths and unknown projects', async () => {
    const { inject, project } = await setup();
    expect((await inject('GET', `/projects/${project.id}/files/content?path=..%2Fsecret`)).statusCode).toBe(400);
    expect((await inject('GET', `/projects/${project.id}/files/tree?path=.git`)).statusCode).toBe(400);
    expect((await inject('GET', '/projects/9999/files/tree')).statusCode).toBe(404);
    expect((await inject('GET', `/projects/${project.id}/files/content?path=missing.txt`)).statusCode).toBe(404);
  });

  it('keeps file access scoped to the routed project', async () => {
    const { inject, project } = await setup();
    const otherRepo = tracked(makeTempRepo({ name: 'code-routes-other' }));
    assertInTemp(otherRepo);
    const other = await inject('POST', '/projects', { name: 'Other', key: 'OTH', repoPath: otherRepo });
    const otherProject = other.json() as { id: number };
    const saved = await inject('PUT', `/projects/${project.id}/files/content`, { path: 'only-a.txt', content: 'secret', expectedSha256: null });
    expect(saved.statusCode).toBe(200);
    expect((await inject('GET', `/projects/${otherProject.id}/files/content?path=only-a.txt`)).statusCode).toBe(404);
    expect((await inject('GET', `/projects/${otherProject.id}/files/tree`)).json()).toMatchObject({ projectId: otherProject.id });
    expect((await inject('GET', `/projects/${otherProject.id}/files/search?q=secret`)).json()).toMatchObject({ matches: [] });
  });

  it('reports a missing checkout as NOT_IN_WORKING_TREE', async () => {
    const { repo, inject, project } = await setup();
    fs.rmSync(repo, { recursive: true, force: true });
    const res = await inject('GET', `/projects/${project.id}/files/tree`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_IN_WORKING_TREE');
  });
});
