// apps/skill-vault/src/catalog.ts — canonical ids, upsert/dedup, discovery pipeline with
// checkpoints and incremental sync, streaming JSONL/CSV export.
import type { VaultConfig } from './config.ts';
import type { VaultDb} from './db.ts';
import { type SkillRow } from './db.ts';
import type { Logger } from './log.ts';
import type { VaultPaths } from './paths.ts';
import {
  isCodingCategory,
  looksLikeCodingSkill,
  type CategoryInfo,
  type SearchPage,
  type SkillSearchItem,
  type SkillsmpClient,
} from './skillsmp.ts';
import { appendJsonl, csvRow, nowIso, readJsonIfExists, writeFileAtomic } from './util.ts';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';

/** Parse a SkillsMP skillUrl into (owner, repo, path-slug). */
export const parseSkillUrl = (skillUrl: string): { owner: string; repo: string; pathSlug: string } | undefined => {
  const match = /^https?:\/\/[^/]+\/creators\/([^/]+)\/([^/]+)\/(.+)$/.exec(skillUrl);
  if (!match) return undefined;
  return { owner: match[1] ?? '', repo: match[2] ?? '', pathSlug: match[3] ?? '' };
};

export const parseGithubUrl = (githubUrl: string): { owner: string; repo: string } | undefined => {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(githubUrl.trim());
  if (!match) return undefined;
  return { owner: match[1] ?? '', repo: match[2] ?? '' };
};

/** Canonical id for a catalog entry discovered through a source. */
export const catalogEntryId = (sourceId: string, externalId: string): string => `${sourceId}:${externalId}`;

/** Canonical id for an individual skill found inside a GitHub repo. */
export const githubSkillId = (owner: string, repo: string, skillPath: string): string =>
  `gh:${owner.toLowerCase()}/${repo.toLowerCase()}/${skillPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')}`;

export function upsertDiscoveredSkill(
  db: VaultDb,
  entry: {
    source: string;
    externalId: string;
    item: SkillSearchItem;
    category: string | undefined;
    isCoding: boolean;
  },
): { row: SkillRow; isNew: boolean } {
  const id = catalogEntryId(entry.source, entry.externalId);
  const now = nowIso();
  const parsed = parseGithubUrl(entry.item.githubUrl) ?? parseSkillUrl(entry.item.skillUrl);
  const stmt = db.db.prepare(`
    INSERT INTO skills (id, source, external_id, name, description, author, repo_owner, repo_name, repo_url,
      skill_path, category, content_language, stars, source_updated_at, skill_url, discovered_at, last_seen_at, status)
    VALUES (@id, @source, @externalId, @name, @description, @author, @repoOwner, @repoName, @repoUrl,
      @skillPath, @category, @contentLanguage, @stars, @sourceUpdatedAt, @skillUrl, @now, @now, @status)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      author = excluded.author,
      repo_owner = excluded.repo_owner,
      repo_name = excluded.repo_name,
      repo_url = excluded.repo_url,
      skill_url = excluded.skill_url,
      category = COALESCE(excluded.category, skills.category),
      content_language = excluded.content_language,
      stars = excluded.stars,
      source_updated_at = excluded.source_updated_at,
      last_seen_at = excluded.last_seen_at
  `);
  const before = db.db.prepare('SELECT id FROM skills WHERE id = ?').get(id) as { id: string } | undefined;
  stmt.run({
    id,
    source: entry.source,
    externalId: entry.externalId,
    name: entry.item.name,
    description: entry.item.description ?? '',
    author: entry.item.author ?? '',
    repoOwner: parsed?.owner ?? '',
    repoName: parsed?.repo ?? '',
    repoUrl: entry.item.githubUrl,
    skillPath: '',
    category: entry.category ?? null,
    contentLanguage: entry.item.contentLanguage ?? null,
    stars: entry.item.stars ?? 0,
    sourceUpdatedAt: entry.item.updatedAt ?? null,
    skillUrl: entry.item.skillUrl,
    now,
    status: 'discovered',
  });
  const row = getSkill(db, id);
  return { row: row!, isNew: before === undefined };
}

export const getSkill = (db: VaultDb, id: string): SkillRow | undefined =>
  db.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;

export const getSkillByExternalId = (db: VaultDb, source: string, externalId: string): SkillRow | undefined =>
  getSkill(db, catalogEntryId(source, externalId));

export type SyncState = {
  discovery?: {
    transport?: string;
    completedPages?: Record<string, number>;
    finishedCategories?: string[];
    lastRunAt?: string;
    categoriesSeen?: string[];
  };
};

export const readSyncState = async (paths: VaultPaths): Promise<SyncState> =>
  (await readJsonIfExists<SyncState>(paths.syncStateJson)) ?? {};

export const writeSyncState = async (paths: VaultPaths, state: SyncState): Promise<void> => {
  await writeFileAtomic(paths.syncStateJson, `${JSON.stringify(state, null, 2)}\n`);
};

export type DiscoveryOptions = {
  categories?: string[];
  maxPagesPerCategory?: number;
  maxItems?: number;
  transport?: 'mcp' | 'rest';
  restQuery?: string;
  resume?: boolean;
};

export type DiscoveryResult = {
  transport: 'mcp' | 'rest';
  categoriesQueried: string[];
  pagesFetched: number;
  upserts: number;
  newSkills: number;
  totalCatalogRows: number;
  incomplete: boolean;
  notes: string[];
};

const CODING_FALLBACK_CATEGORIES = ['software-development', 'devops', 'data-ai', 'coding'];

/** The discovery pipeline: enumerate coding categories, page through search, upsert + mirror. */
export async function runDiscovery(
  ctx: {
    db: VaultDb;
    client: SkillsmpClient;
    config: VaultConfig;
    paths: VaultPaths;
    logger: Logger;
  },
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const { db, client, config, paths, logger } = ctx;
  const notes: string[] = [];
  const syncState = await readSyncState(paths);
  const completedPages = syncState.discovery?.completedPages ?? {};
  const finishedCategories = new Set(syncState.discovery?.finishedCategories ?? []);
  const maxPages = opts.maxPagesPerCategory ?? 20;
  const maxItems = opts.maxItems ?? Number.MAX_SAFE_INTEGER;

  // Choose transport: MCP first (no daily quota). REST only on explicit request or MCP failure.
  let transport: 'mcp' | 'rest' = opts.transport ?? 'mcp';
  if (transport === 'mcp') {
    try {
      await client.mcpListCategories();
    } catch (error) {
      notes.push(`MCP unavailable (${(error as Error).message}); falling back to REST search (anonymous 50/day quota).`);
      transport = 'rest';
    }
  }

  let categories: CategoryInfo[] = [];
  if (transport === 'mcp') {
    try {
      categories = await client.mcpListCategories();
    } catch (error) {
      notes.push(`list_categories failed: ${(error as Error).message}`);
    }
  }
  const slugLabels = new Map(categories.map((category) => [category.slug, category.label ?? category.slug]));

  let categorySlugs: string[];
  if (opts.categories !== undefined && opts.categories.length > 0) {
    categorySlugs = opts.categories;
  } else if (config.coding.categories.length > 0) {
    categorySlugs = config.coding.categories;
  } else {
    const classified = categories.filter(isCodingCategory).map((c) => c.slug);
    categorySlugs = classified.length > 0 ? classified : CODING_FALLBACK_CATEGORIES;
    if (classified.length === 0 && categories.length > 0) {
      notes.push(`No category matched the coding heuristics; using fallback list ${CODING_FALLBACK_CATEGORIES.join(', ')}.`);
    }
  }
  if (categories.length > 0) {
    notes.push(`Source exposed ${categories.length} categories; ${categorySlugs.length} selected as coding-related.`);
  } else if (transport === 'rest') {
    // Without a category list, extra REST passes would only burn the anonymous daily quota:
    // run ONE keyword pass (q) with no category filter.
    categorySlugs = [opts.restQuery ?? 'code'];
    notes.push('Category list unavailable over REST; running a single keyword pass without a category filter.');
  } else {
    notes.push('Category list unavailable; category filter not applied to page counts.');
  }

  const syncRun = db.db
    .prepare(
      `INSERT INTO sync_runs (source, mode, params_json, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
    )
    .run('skillsmp', `discover-${transport}`, JSON.stringify({ categories: categorySlugs, maxPages }), nowIso());
  const syncRunId = Number(syncRun.lastInsertRowid);

  let pagesFetched = 0;
  let upserts = 0;
  let newSkills = 0;
  let incomplete = false;

  for (const slug of categorySlugs) {
    if (finishedCategories.has(slug) && opts.resume !== false) continue; // fully enumerated in a previous run
    const resumeFrom = opts.resume !== false ? (completedPages[slug] ?? 0) + 1 : 1;
    for (let page = resumeFrom; page <= maxPages; page += 1) {
      if (upserts >= maxItems) {
        incomplete = true;
        break;
      }
      let result: SearchPage;
      try {
        const query =
          transport === 'rest'
            ? opts.restQuery ?? 'code'
            : (slugLabels.get(slug) ?? slug).replaceAll('-', ' ').trim() || 'code';
        result = await client.searchPage({
          q: query,
          category: categories.length > 0 || transport === 'mcp' ? slug : undefined,
          page,
          limit: 50,
          transport,
        });
      } catch (error) {
        notes.push(`Category "${slug}" page ${page} failed: ${(error as Error).message}`);
        incomplete = true;
        break;
      }
      pagesFetched += 1;
      for (const item of result.items) {
        if (upserts >= maxItems) {
          incomplete = true;
          break;
        }
        const { isNew } = upsertDiscoveredSkill(db, {
          source: 'skillsmp',
          externalId: item.id,
          item,
          category: categories.length > 0 ? slug : undefined, // don't mislabel a keyword-only pass
          isCoding: true,
        });
        upserts += 1;
        if (isNew) {
          newSkills += 1;
          await appendJsonl(paths.skillsJsonl, {
            kind: 'discovered',
            at: nowIso(),
            source: 'skillsmp',
            external_id: item.id,
            name: item.name,
            author: item.author,
            github_url: item.githubUrl,
            skill_url: item.skillUrl,
            stars: item.stars,
            category: slug,
            content_language: item.contentLanguage ?? null,
            source_updated_at: item.updatedAt ?? null,
            coding_heuristic: looksLikeCodingSkill(item),
          });
        }
      }
      completedPages[slug] = page;
      if (!result.hasNext) finishedCategories.add(slug);
      await writeSyncState(paths, {
        ...syncState,
        discovery: {
          ...syncState.discovery,
          completedPages,
          finishedCategories: [...finishedCategories],
          lastRunAt: nowIso(),
          transport,
        },
      });
      if (!result.hasNext) break;
    }
    if (upserts >= maxItems) break;
  }

  db.db
    .prepare('UPDATE sync_runs SET finished_at = ?, status = ?, pages = ?, upserts = ?, error = ? WHERE id = ?')
    .run(nowIso(), incomplete ? 'incomplete' : 'complete', pagesFetched, upserts, notes.join(' ') || null, syncRunId);

  const total = (
    db.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }
  ).n;

  logger.info('discovery finished', { transport, pagesFetched, upserts, newSkills, total, incomplete });
  return {
    transport,
    categoriesQueried: categorySlugs,
    pagesFetched,
    upserts,
    newSkills,
    totalCatalogRows: total,
    incomplete,
    notes,
  };
}

/** Stream the whole catalog to CSV without loading it into memory. */
export async function exportCatalogCsv(db: VaultDb, outPath: string): Promise<number> {
  const columns = [
    'id', 'source', 'external_id', 'name', 'author', 'repo_owner', 'repo_name', 'repo_url', 'skill_path',
    'category', 'content_language', 'stars', 'status', 'license', 'downloaded_at', 'download_commit',
    'content_sha256', 'dup_of_id', 'skill_url',
  ];
  const stream = createWriteStream(outPath, { flags: 'w' });
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.write(`${csvRow(columns)}\n`);
    const rows = db.db.prepare('SELECT * FROM skills ORDER BY id').iterate() as Iterable<SkillRow>;
    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      stream.write(`${csvRow(columns.map((column) => record[column]))}\n`);
    }
    stream.end(() => resolve());
  });
  const stat = await fsp.stat(outPath);
  return stat.size;
}
