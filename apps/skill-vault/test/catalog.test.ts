// apps/skill-vault/test/catalog.test.ts — discovery pipeline: pagination, dedup, checkpoints,
// resume, incomplete pages, item caps, JSONL mirror.
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import { VaultDb } from '../src/db.ts';
import { vaultConfigSchema } from '../src/config.ts';
import { parseGithubUrl, runDiscovery, upsertDiscoveredSkill, readSyncState } from '../src/catalog.ts';
import { Logger } from '../src/log.ts';
import { ensureVaultLayout, vaultPaths } from '../src/paths.ts';
import { makeTempDir } from './helpers/temp.ts';
import type { CategoryInfo, SearchPage, SkillSearchItem } from '../src/skillsmp.ts';

const item = (id: string, name: string, repo: string): SkillSearchItem => ({
  id,
  name,
  author: repo.split('/')[0] ?? 'a',
  description: `${name} does coding things`,
  githubUrl: `https://github.com/${repo}`,
  skillUrl: `https://skillsmp.com/creators/${repo}/${id}`,
  stars: 10,
  updatedAt: 1_700_000_000,
});

const fakeClient = (pages: Record<string, SearchPage[]>, categories: CategoryInfo[]) => {
  const calls: string[] = [];
  return {
    calls,
    async mcpListCategories(): Promise<CategoryInfo[]> {
      return categories;
    },
    async searchPage(params: { category?: string; page?: number; limit?: number }): Promise<SearchPage> {
      const key = params.category ?? '*';
      calls.push(`${key}:${params.page ?? 1}`);
      const list = pages[key] ?? [];
      const page = list[(params.page ?? 1) - 1];
      if (page === undefined) throw new Error('page beyond fixture');
      return page;
    },
  };
};

const setup = () => {
  const root = makeTempDir();
  const paths = vaultPaths(root);
  return { root, paths, db: VaultDb.open(paths.sqlite) };
};

describe('catalog', () => {
  it('parses GitHub URLs strictly', () => {
    expect(parseGithubUrl('https://github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' });
    expect(parseGithubUrl('https://github.com/anthropics/skills.git')).toEqual({ owner: 'anthropics', repo: 'skills' });
    expect(parseGithubUrl('https://gitlab.com/a/b')).toBeUndefined();
    expect(parseGithubUrl('https://github.com/a/b/tree/main')).toBeUndefined();
  });

  it('upserts idempotently: the same external id updates one row', () => {
    const { db } = setup();
    const first = upsertDiscoveredSkill(db, { source: 'skillsmp', externalId: 's1', item: item('s1', 'react-best', 'vercel-labs/skills'), category: 'coding', isCoding: true });
    const second = upsertDiscoveredSkill(db, { source: 'skillsmp', externalId: 's1', item: { ...item('s1', 'react-best-practices', 'vercel-labs/skills'), stars: 99 }, category: 'coding', isCoding: true });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    const count = (db.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n;
    expect(count).toBe(1);
    expect(second.row.stars).toBe(99);
    expect(second.row.name).toBe('react-best-practices');
  });

  it('pages through categories following hasNext, checkpoints progress and mirrors to JSONL', async () => {
    const { paths, db } = setup();
    await ensureVaultLayout(paths);
    const client = fakeClient(
      {
        'software-development': [
          { items: [item('s1', 'tdd', 'a/one'), item('s2', 'refactor', 'a/two')], page: 1, hasNext: true, total: 3, totalIsExact: true },
          { items: [item('s3', 'debug', 'a/three')], page: 2, hasNext: false, total: 3, totalIsExact: true },
        ],
      },
      [{ slug: 'software-development', label: 'Software Development' }, { slug: 'cooking', label: 'Cooking' }],
    );
    const result = await runDiscovery(
      { db, client: client as never, config: vaultConfigSchema.parse({}), paths, logger: Logger.silent() },
      {},
    );
    expect(result.transport).toBe('mcp');
    expect(result.pagesFetched).toBe(2);
    expect(result.newSkills).toBe(3);
    expect(client.calls).toEqual(['software-development:1', 'software-development:2']);
    const state = await readSyncState(paths);
    expect(state.discovery?.completedPages?.['software-development']).toBe(2);
    const jsonl = await fsp.readFile(paths.skillsJsonl, 'utf8');
    expect(jsonl.split('\n').filter((line) => line.length > 0).length).toBe(3);
    expect(result.incomplete).toBe(false);
  });

  it('resumes from the checkpoint without refetching completed pages', async () => {
    const { paths, db } = setup();
    await ensureVaultLayout(paths);
    const client = fakeClient(
      {
        'software-development': [
          { items: [item('s1', 'tdd', 'a/one')], page: 1, hasNext: true, total: 2, totalIsExact: true },
          { items: [item('s2', 'debug', 'a/two')], page: 2, hasNext: false, total: 2, totalIsExact: true },
        ],
      },
      [{ slug: 'software-development' }],
    );
    const ctx = { db, client: client as never, config: vaultConfigSchema.parse({}), paths, logger: Logger.silent() };
    await runDiscovery(ctx, {});
    const callsAfterFirstRun = client.calls.length;
    const second = await runDiscovery(ctx, {});
    expect(client.calls.length).toBe(callsAfterFirstRun); // finished category not re-probed
    expect(second.newSkills).toBe(0);
    expect(second.upserts).toBe(0);
    expect(second.incomplete).toBe(false);
  });

  it('records incomplete pages as incomplete and continues other categories', async () => {
    const { paths, db } = setup();
    await ensureVaultLayout(paths);
    const client = {
      calls: [] as string[],
      async mcpListCategories(): Promise<CategoryInfo[]> {
        return [{ slug: 'broken-coding' }, { slug: 'fine-coding' }];
      },
      async searchPage(params: { category?: string; page?: number }): Promise<SearchPage> {
        if (params.category === 'broken-coding') throw new Error('SEARCH_INDEX_UNAVAILABLE');
        return { items: [item('s9', 'ok', 'a/nine')], page: params.page ?? 1, hasNext: false, total: 1, totalIsExact: true };
      },
    };
    const result = await runDiscovery(
      { db, client: client as never, config: vaultConfigSchema.parse({}), paths, logger: Logger.silent() },
      {},
    );
    expect(result.incomplete).toBe(true);
    expect(result.newSkills).toBe(1);
    expect(result.notes.some((note) => note.includes('broken-coding'))).toBe(true);
  });

  it('stops at the item cap and marks the run incomplete', async () => {
    const { paths, db } = setup();
    await ensureVaultLayout(paths);
    const many = Array.from({ length: 50 }, (_, i) => item(`s${i}`, `skill-${i}`, `a/r${i}`));
    const client = fakeClient(
      { 'big-coding': [{ items: many, page: 1, hasNext: true, total: 50, totalIsExact: true }] },
      [{ slug: 'big-coding' }],
    );
    const result = await runDiscovery(
      { db, client: client as never, config: vaultConfigSchema.parse({}), paths, logger: Logger.silent() },
      { maxItems: 10 },
    );
    expect(result.upserts).toBe(10);
    expect(result.incomplete).toBe(true);
  });
});
