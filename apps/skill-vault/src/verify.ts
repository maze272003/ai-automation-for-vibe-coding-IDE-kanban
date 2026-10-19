// apps/skill-vault/src/verify.ts — integrity verification: recompute hashes of stored skill
// content and compare against the manifest recorded at download time.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VaultDb} from './db.ts';
import { type SkillRow } from './db.ts';
import { skillDirFor, type VaultPaths } from './paths.ts';
import { sha256File } from './util.ts';

export type VerifyResult = {
  checked: number;
  ok: number;
  missing: Array<{ skillId: string; dir: string }>;
  mismatched: Array<{ skillId: string; path: string; expected: string; actual: string }>;
  provenanceIssues: Array<{ skillId: string; issue: string }>;
};

type Provenance = { skill_id?: string; content_sha256?: string; repo?: { commit?: string } };

export async function verifyVault(db: VaultDb, paths: VaultPaths): Promise<VerifyResult> {
  const result: VerifyResult = { checked: 0, ok: 0, missing: [], mismatched: [], provenanceIssues: [] };
  const rows = db.db
    .prepare(`SELECT * FROM skills WHERE downloaded_at IS NOT NULL AND status != 'duplicate'`)
    .all() as SkillRow[];
  const manifest = db.db.prepare('SELECT path, sha256 FROM skill_files WHERE skill_id = ?');

  for (const row of rows) {
    const dir = skillDirFor(paths, row);
    const files = manifest.all(row.id) as Array<{ path: string; sha256: string }>;
    if (files.length === 0) {
      result.provenanceIssues.push({ skillId: row.id, issue: 'no file manifest recorded' });
      continue;
    }
    for (const file of files) {
      const target = path.join(dir, file.path);
      result.checked += 1;
      try {
        const actual = await sha256File(target);
        if (actual !== file.sha256) {
          result.mismatched.push({ skillId: row.id, path: file.path, expected: file.sha256, actual });
        } else {
          result.ok += 1;
        }
      } catch {
        result.missing.push({ skillId: row.id, dir: path.join(dir, file.path) });
      }
    }
    const provenance = JSON.parse(await fsp.readFile(path.join(dir, 'provenance.json'), 'utf8').catch(() => '{}')) as Provenance;
    if (provenance.skill_id !== row.id) {
      result.provenanceIssues.push({ skillId: row.id, issue: 'provenance.json skill_id does not match the database row' });
    }
    if (row.content_sha256 !== null && provenance.content_sha256 !== row.content_sha256) {
      result.provenanceIssues.push({ skillId: row.id, issue: 'provenance.json content hash differs from the database' });
    }
    if (row.download_commit !== null && provenance.repo?.commit !== undefined && provenance.repo.commit !== row.download_commit) {
      result.provenanceIssues.push({ skillId: row.id, issue: 'provenance.json commit pin differs from the database' });
    }
  }
  return result;
}
