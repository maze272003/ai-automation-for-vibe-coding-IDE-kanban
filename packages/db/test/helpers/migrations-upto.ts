import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInTemp } from '../../../../apps/orchestrator/test/helpers/temp.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

interface Journal {
  version: string;
  dialect: string;
  entries: { idx: number; tag: string; when: number }[];
}

/**
 * Copies every `NNNN_*.sql` migration up to and including `tag`, plus a `meta/_journal.json`
 * holding only those entries, into `dir` — a migrations folder frozen at an older schema.
 */
export function migrationsUpTo(tag: string, dir: string): string {
  assertInTemp(dir);
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const end = journal.entries.findIndex((e) => e.tag === tag);
  if (end < 0) throw new Error(`unknown migration tag: ${tag}`);
  const entries = journal.entries.slice(0, end + 1);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  for (const e of entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  return dir;
}
