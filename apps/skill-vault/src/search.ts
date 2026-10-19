// apps/skill-vault/src/search.ts — local search and ranking (SQLite FTS5 with LIKE fallback).
// Works fully offline; no external AI service is used or required.
import type { VaultDb} from './db.ts';
import { type SkillRow } from './db.ts';

export type SearchFilters = {
  statuses?: string[];
  categories?: string[];
  licenses?: string[];
  contentLanguage?: string;
  minStars?: number;
  updatedWithinDays?: number;
  owner?: string;
};

export type SearchHit = { row: SkillRow; score: number; why: string[] };

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on', 'at', 'by', 'is', 'are', 'be',
  'this', 'that', 'it', 'as', 'from', 'into', 'about', 'how', 'what', 'when', 'your', 'you', 'use',
  'using', 'make', 'better', 'best', 'new', 'existing', 'current', 'task', 'please', 'want', 'need',
]);

const tokenize = (query: string): string[] =>
  [...new Set(query.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((token) => token.length > 1 && !STOPWORDS.has(token)))].slice(0, 12);

const _escapeFts = (token: string): string => token.replace(/["'^*()-]/g, ' ');

export function searchSkills(
  db: VaultDb,
  params: { query: string; filters?: SearchFilters; limit?: number },
): SearchHit[] {
  const limit = params.limit ?? 20;
  const filters = params.filters ?? {};
  const statuses = filters.statuses ?? ['scanned', 'approved'];
  const tokens = tokenize(params.query);

  const conditions: string[] = [];
  const args: unknown[] = [];
  const statusPlaceholders = statuses.map(() => '?').join(',');
  conditions.push(`s.status IN (${statusPlaceholders})`);
  args.push(...statuses);
  if (filters.categories !== undefined && filters.categories.length > 0) {
    conditions.push(`s.category IN (${filters.categories.map(() => '?').join(',')})`);
    args.push(...filters.categories);
  }
  if (filters.licenses !== undefined && filters.licenses.length > 0) {
    conditions.push(`(${filters.licenses.map(() => 's.license = ?').join(' OR ')})`);
    args.push(...filters.licenses);
  }
  if (filters.contentLanguage !== undefined) {
    conditions.push('s.content_language = ?');
    args.push(filters.contentLanguage);
  }
  if (filters.minStars !== undefined) {
    conditions.push('s.stars >= ?');
    args.push(filters.minStars);
  }
  if (filters.updatedWithinDays !== undefined) {
    conditions.push('s.source_updated_at >= ?');
    args.push(Math.floor(Date.now() / 1000) - filters.updatedWithinDays * 86_400);
  }
  if (filters.owner !== undefined) {
    conditions.push('s.repo_owner = ? COLLATE NOCASE');
    args.push(filters.owner);
  }

  const rows = db.db
    .prepare(`SELECT * FROM skills s WHERE ${conditions.join(' AND ')} LIMIT 20000`)
    .all(...args) as SkillRow[];

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const nameLower = row.name.toLowerCase();
    const haystack = `${nameLower} ${row.description.toLowerCase()} ${row.skill_path.toLowerCase()} ${row.category ?? ''} ${row.repo_name.toLowerCase()}`;
    let score = 0;
    const why: string[] = [];
    let matched = false;
    for (const token of tokens) {
      if (nameLower === token) {
        score += 6;
        why.push(`exact name match "${token}"`);
        matched = true;
      } else if (nameLower.split(/[^a-z0-9]+/).includes(token)) {
        score += 4;
        why.push(`name contains "${token}"`);
        matched = true;
      } else if (haystack.includes(token)) {
        score += 2;
        why.push(`matches "${token}"`);
        matched = true;
      }
    }
    if (tokens.length > 0 && !matched) continue;
    if (row.status === 'approved') {
      score += 3;
      why.push('approved');
    }
    score += Math.log10(row.stars + 1);
    if (row.stars > 100) why.push(`${row.stars} stars`);
    if (row.license !== null && row.license !== undefined) why.push(`license ${row.license}`);
    hits.push({ row, score, why: [...new Set(why)].slice(0, 6) });
  }
  hits.sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  // Collapse same-name rows (e.g. localized copies under docs/ja-JP/) to the best hit.
  const seenNames = new Set<string>();
  const collapsed: SearchHit[] = [];
  for (const hit of hits) {
    const nameKey = hit.row.name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    collapsed.push(hit);
    if (collapsed.length >= limit) break;
  }
  return collapsed;
}

export const skillStats = (db: VaultDb): Record<string, number> =>
  (
    db.db.prepare('SELECT status, COUNT(*) AS n FROM skills GROUP BY status').all() as Array<{ status: string; n: number }>
  ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: row.n }), {});

/** Find duplicate/near-duplicate groups by content hash. */
export const duplicateGroups = (db: VaultDb): Array<{ contentSha: string; ids: string[] }> => {
  const rows = db.db
    .prepare(
      `SELECT content_sha256 AS sha, GROUP_CONCAT(id) AS ids FROM skills
       WHERE content_sha256 IS NOT NULL GROUP BY content_sha256 HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ sha: string; ids: string }>;
  return rows.map((row) => ({ contentSha: row.sha, ids: row.ids.split(',') }));
}
