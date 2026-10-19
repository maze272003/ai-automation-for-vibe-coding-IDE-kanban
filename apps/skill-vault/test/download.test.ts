// apps/skill-vault/test/download.test.ts — engine: single/multi-skill repos, dedup, resume,
// failures, dry-run, malformed archives, provenance + hashes.
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultDb } from '../src/db.ts';
import { vaultConfigSchema } from '../src/config.ts';
import { PoliteHttpClient } from '../src/http.ts';
import { runDownload } from '../src/download.ts';
import { Logger } from '../src/log.ts';
import { ensureVaultLayout, vaultPaths } from '../src/paths.ts';
import { sha256Hex } from '../src/util.ts';
import { makeTempDir } from './helpers/temp.ts';
import { cleanSkillMd, fakeFetch, fakeResolver, gzip, repoTarball } from './helpers/fixtures.ts';
import { buildTar } from './helpers/fixtures.ts';

const setup = () => {
  const root = makeTempDir();
  const paths = vaultPaths(root);
  return { root, paths, db: VaultDb.open(paths.sqlite) };
};

const seedEntry = (db: VaultDb, id: string, name: string, owner: string, repo: string, description = ''): void => {
  db.db
    .prepare(
      `INSERT INTO skills (id, source, external_id, name, description, author, repo_owner, repo_name, repo_url,
        skill_path, category, stars, skill_url, discovered_at, last_seen_at, status)
       VALUES (?, 'skillsmp', ?, ?, ?, ?, ?, ?, ?, '', 'coding', 5, ?, ?, ?, 'discovered')`,
    )
    .run(id, id, name, description, owner, owner, repo, `https://github.com/${owner}/${repo}`, `https://skillsmp.com/creators/${owner}/${repo}/${id}`, new Date().toISOString(), new Date().toISOString());
};

const makeCtx = (tarballs: Record<string, Buffer>, commit = 'f'.repeat(40)) => {
  const { paths, db } = setup();
  void paths;
  return { paths, db, ctx: { db, config: vaultConfigSchema.parse({}), paths, http: httpWithTarballs(tarballs), github: fakeResolver(commit), logger: Logger.silent() } as const };
};

const httpWithTarballs = (tarballs: Record<string, Buffer>): PoliteHttpClient =>
  new PoliteHttpClient({
    userAgent: 'test',
    minIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 5_000,
    fetch: fakeFetch({
      'https://codeload.github.com/': (url: URL) => {
        const match = /\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})/.exec(url.pathname);
        const key = match ? `${match[1]}/${match[2]}` : url.pathname;
        const tarball = tarballs[key];
        if (tarball === undefined) return { status: 404, body: 'no such repo' };
        return { body: tarball, headers: { 'content-type': 'application/gzip' } };
      },
    }),
  });

describe('download engine', () => {
  it('downloads a single-skill repo into the catalog row with provenance and hashes', async () => {
    const { paths, db, ctx } = makeCtx({
      'vercel-labs/skills': repoTarball('skills', 'f'.repeat(40), {
        'SKILL.md': cleanSkillMd('react-best-practices'),
        'LICENSE': 'MIT License\n',
        'reference.md': 'Use hooks.',
      }),
    });
    seedEntry(db, 'skillsmp:e1', 'React Best Practices', 'vercel-labs', 'skills');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.skillsDownloaded).toBe(1);
    expect(result.reposProcessed).toBe(1);
    const row = db.db.prepare('SELECT * FROM skills WHERE id = ?').get('skillsmp:e1') as { status: string; skill_path: string; content_sha256: string | null; license: string | null; download_commit: string | null };
    expect(row.status).toBe('downloaded');
    expect(row.skill_path).toBe('.');
    expect(row.license).toBe('MIT');
    expect(row.download_commit).toBe('f'.repeat(40));
    const skillMd = await fsp.readFile(path.join(paths.skillsQuarantined, 'vercel-labs', 'skills', 'react-best-practices', 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('react-best-practices');
    expect(row.content_sha256).toBe(sha256Hex(skillMd));
    const provenance = JSON.parse(await fsp.readFile(path.join(paths.skillsQuarantined, 'vercel-labs', 'skills', 'react-best-practices', 'provenance.json'), 'utf8')) as { repo: { commit: string }; source: string };
    expect(provenance.repo.commit).toBe('f'.repeat(40));
    expect(provenance.source).toBe('skillsmp');
  });

  it('expands a multi-skill repo into child rows and marks the entry as skipped', async () => {
    const { db, ctx } = makeCtx({
      'anthropics/skills': repoTarball('skills', 'f'.repeat(40), {
        'skills/pdf/SKILL.md': cleanSkillMd('pdf'),
        'skills/xlsx/SKILL.md': cleanSkillMd('xlsx'),
        'LICENSE': 'MIT License\n',
      }),
    });
    seedEntry(db, 'skillsmp:e2', 'Anthropic Skills', 'anthropics', 'skills');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.skillsDownloaded).toBe(2);
    expect(result.expandedEntries).toBe(1);
    const children = db.db.prepare("SELECT * FROM skills WHERE id LIKE 'gh:%'").all() as Array<{ id: string; repo_entry_id: string | null; status: string }>;
    expect(children.map((child) => child.id).sort()).toEqual(['gh:anthropics/skills/skills/pdf', 'gh:anthropics/skills/skills/xlsx']);
    for (const child of children) {
      expect(child.repo_entry_id).toBe('skillsmp:e2');
      expect(child.status).toBe('downloaded');
    }
    const entry = db.db.prepare('SELECT status, failure_reason FROM skills WHERE id = ?').get('skillsmp:e2') as { status: string; failure_reason: string };
    expect(entry.status).toBe('skipped');
    expect(entry.failure_reason).toContain('expanded');
  });

  it('flags byte-identical skill content as a duplicate with provenance kept', async () => {
    const commit = 'f'.repeat(40);
    const tarball = repoTarball('one', commit, { 'SKILL.md': cleanSkillMd('tdd') });
    const { db, ctx } = makeCtx({ 'a/one': tarball, 'b/two': repoTarball('two', commit, { 'SKILL.md': cleanSkillMd('tdd') }) });
    seedEntry(db, 'skillsmp:a1', 'TDD One', 'a', 'one');
    seedEntry(db, 'skillsmp:b1', 'TDD Two', 'b', 'two');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.skillsDownloaded).toBe(1);
    expect(result.duplicates).toBe(1);
    const dup = db.db.prepare('SELECT * FROM skills WHERE id = ?').get('skillsmp:b1') as { status: string; dup_of_id: string | null };
    expect(dup.status).toBe('duplicate');
    expect(dup.dup_of_id).toBe('skillsmp:a1');
  });

  it('skips unchanged repos on a second (resume) run — incremental sync', async () => {
    const { db, ctx } = makeCtx({
      'a/one': repoTarball('one', 'f'.repeat(40), { 'SKILL.md': cleanSkillMd('tdd') }),
    });
    seedEntry(db, 'skillsmp:a1', 'TDD', 'a', 'one');
    await runDownload(ctx, { kind: 'coding' });
    const second = await runDownload(ctx, { kind: 'coding' });
    expect(second.skillsDownloaded).toBe(0);
    expect(second.reposConsidered).toBe(0); // nothing pending: row no longer 'discovered'
  });

  it('records failures per skill with the attempt log', async () => {
    const { db, ctx } = makeCtx({}); // no routes → 404 for every repo
    seedEntry(db, 'skillsmp:x1', 'Ghost', 'a', 'missing');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.failed).toBe(1);
    const row = db.db.prepare('SELECT status, failure_reason FROM skills WHERE id = ?').get('skillsmp:x1') as { status: string; failure_reason: string };
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBeTruthy();
    const attempts = db.db.prepare('SELECT outcome FROM download_attempts WHERE skill_id = ?').all('skillsmp:x1') as Array<{ outcome: string }>;
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });

  it('dry-run makes no network requests and lists what would happen', async () => {
    let calls = 0;
    const http = new PoliteHttpClient({
      userAgent: 'test',
      minIntervalMs: 0,
      maxRetries: 0,
      timeoutMs: 5_000,
      fetch: (async () => {
        calls += 1;
        return new Response('');
      }) as typeof fetch,
    });
    const { paths, db } = setup();
    await ensureVaultLayout(paths);
    seedEntry(db, 'skillsmp:d1', 'Dry', 'a', 'dry');
    const result = await runDownload({ db, config: vaultConfigSchema.parse({}), paths, http, github: fakeResolver(), logger: Logger.silent() }, { kind: 'coding' }, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(calls).toBe(0);
    expect(result.notes.some((note) => note.includes('would download'))).toBe(true);
  });

  it('rejects traversal-laden archives without writing files', async () => {
    const { paths, db, ctx } = makeCtx({
      'a/evil': gzip(buildTar([{ name: 'evil-123/SKILL.md', data: Buffer.from(cleanSkillMd('evil')) }, { name: '../../escape.md', data: Buffer.from('boom') }])),
    });
    seedEntry(db, 'skillsmp:evil1', 'Evil', 'a', 'evil');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.failed).toBe(1);
    const row = db.db.prepare('SELECT status FROM skills WHERE id = ?').get('skillsmp:evil1') as { status: string };
    expect(row.status).toBe('failed');
    const escape = path.join(paths.skillsQuarantined, 'a', 'evil');
    const written = await fsp.readdir(path.dirname(escape)).catch(() => [] as string[]);
    expect(written.includes('evil')).toBe(false);
  });

  it('fails gracefully when a repo contains no SKILL.md', async () => {
    const { db, ctx } = makeCtx({
      'a/docs': repoTarball('docs', 'f'.repeat(40), { 'README.md': 'just docs' }),
    });
    seedEntry(db, 'skillsmp:no1', 'No Skill', 'a', 'docs');
    const result = await runDownload(ctx, { kind: 'coding' });
    expect(result.failed).toBe(1);
    const row = db.db.prepare('SELECT failure_reason FROM skills WHERE id = ?').get('skillsmp:no1') as { failure_reason: string };
    expect(row.failure_reason).toContain('no SKILL.md');
  });
});
