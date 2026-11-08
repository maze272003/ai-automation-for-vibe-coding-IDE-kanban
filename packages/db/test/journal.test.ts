import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const readJournal = () => JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;

describe('migrations journal', () => {
  it('journal entries have strictly increasing when, contiguous idx, and a .sql per tag', () => {
    const j = readJournal();
    j.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      if (i > 0) expect(e.when).toBeGreaterThan(j.entries[i - 1]!.when);
      expect(fs.existsSync(path.join(MIGRATIONS, `${e.tag}.sql`))).toBe(true);
    });
    const sqlFiles = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4));
    expect(sqlFiles.sort()).toEqual(j.entries.map((e) => e.tag).sort());
  });

  it('includes 0004_usage_cost_run_skills as entry 4', () => {
    expect(readJournal().entries[4]?.tag).toBe('0004_usage_cost_run_skills');
  });
});
