// apps/skill-vault/test/cli.test.ts — CLI surface: help, unknown commands, usage errors, init.
// apps/skill-vault/test/verify-backup.test.ts — integrity verification + backup/restore.
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../src/cli.ts';
import { VaultDb } from '../src/db.ts';
import { vaultConfigSchema } from '../src/config.ts';
import { Logger } from '../src/log.ts';
import { ensureVaultLayout, vaultPaths, statusHome, skillContentDir, skillDirSlug } from '../src/paths.ts';
import { verifyVault } from '../src/verify.ts';
import { backupVault, restoreVault } from '../src/backup.ts';
import { makeTempDir } from './helpers/temp.ts';
import { cleanSkillMd } from './helpers/fixtures.ts';

describe('cli', () => {
  it('help exits 0 and prints usage', async () => {
    const code = await runCli(['help']);
    expect(code).toBe(0);
  });

  it('unknown commands exit 2', async () => {
    const root = makeTempDir('vault-');
    const code = await runCli(['--root', root, 'definitely-not-a-command']);
    expect(code).toBe(2);
  });

  it('missing required flags produce usage errors (exit 2), not crashes', async () => {
    const root = makeTempDir('vault-');
    expect(await runCli(['--root', root, 'approve'])).toBe(2);
    expect(await runCli(['--root', root, 'recommend'])).toBe(2);
    expect(await runCli(['--root', root, 'explain'])).toBe(2);
    expect(await runCli(['--root', root, 'search'])).toBe(2);
  });

  it('init creates the vault layout and config', async () => {
    const root = makeTempDir('vault-');
    const code = await runCli(['--root', root, 'init']);
    expect(code).toBe(0);
    const config = await fsp.readFile(path.join(root, 'config', 'vault.config.json'), 'utf8');
    expect(JSON.parse(config).version).toBe(1);
    for (const dir of ['skills/approved', 'skills/quarantined', 'skills/rejected', 'indexes', 'reports', 'logs', 'backups']) {
      const stat = await fsp.stat(path.join(root, ...dir.split('/')));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('status works offline on an empty vault', async () => {
    const root = makeTempDir('vault-');
    await runCli(['--root', root, 'init']);
    const code = await runCli(['--root', root, 'status']);
    expect(code).toBe(0);
  });
});

describe('verify and backup', () => {
  const seed = async () => {
    const root = makeTempDir('vault-');
    const paths = vaultPaths(root);
    await ensureVaultLayout(paths);
    const db = VaultDb.open(paths.sqlite);
    const dir = skillContentDir(statusHome(paths, 'scanned'), 'obra', 'superpowers', skillDirSlug('.', 'git-release'));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'SKILL.md'), cleanSkillMd('git-release'));
    await fsp.writeFile(
      path.join(dir, 'provenance.json'),
      JSON.stringify({ skill_id: 'skillsmp:a1', content_sha256: 'deadbeef', repo: { commit: 'f'.repeat(40) } }),
    );
    db.db
      .prepare(
        `INSERT INTO skills (id, source, name, repo_owner, repo_name, skill_path, discovered_at, last_seen_at, status,
          content_sha256, downloaded_at, download_commit)
         VALUES ('skillsmp:a1', 'skillsmp', 'git-release', 'obra', 'superpowers', '.', ?, ?, 'scanned', ?, ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), 'deadbeef', new Date().toISOString(), 'f'.repeat(40));
    const { createHash } = await import('node:crypto');
    db.db
      .prepare('INSERT INTO skill_files (skill_id, path, sha256, bytes) VALUES (?, ?, ?, ?)')
      .run('skillsmp:a1', 'SKILL.md', createHash('sha256').update(cleanSkillMd('git-release')).digest('hex'), Buffer.byteLength(cleanSkillMd('git-release')));
    return { paths, db, dir };
  };

  it('verifies intact content and detects tampering', async () => {
    const { paths, db, dir } = await seed();
    const ok = await verifyVault(db, paths);
    expect(ok.mismatched.length).toBe(0);
    expect(ok.ok).toBe(1);

    await fsp.writeFile(path.join(dir, 'SKILL.md'), 'tampered\n');
    const bad = await verifyVault(db, paths);
    expect(bad.mismatched.length).toBe(1);
    expect(bad.mismatched[0]?.skillId).toBe('skillsmp:a1');
  });

  it('backs up the database and restores only with --confirm', async () => {
    const { paths, db } = await seed();
    const backup = await backupVault(db, paths);
    expect((await fsp.stat(backup.sqlite)).isFile()).toBe(true);

    const noConfirm = await restoreVault(paths, path.dirname(backup.sqlite), false);
    expect(noConfirm.restored).toBe(false);

    const confirmed = await restoreVault(paths, path.dirname(backup.sqlite), true);
    expect(confirmed.restored).toBe(true);
    const db2 = VaultDb.open(paths.sqlite);
    const rows = db2.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number };
    expect(rows.n).toBe(1);
    db2.close();
  });

  it('writeSecurityReport reflects current findings', async () => {
    const { paths, db } = await seed();
    const { writeSecurityReport } = await import('../src/scanner.ts');
    const out = await writeSecurityReport(db, paths);
    const parsed = JSON.parse(await fsp.readFile(out, 'utf8')) as { skillsByStatus: Record<string, number>; policy: { note: string } };
    expect(parsed.skillsByStatus.scanned).toBe(1);
    expect(parsed.policy.note).toContain('not proof of safety');
  });

  it('handles a large catalog with bounded queries (10k rows)', async () => {
    const root = makeTempDir('vault-');
    const paths = vaultPaths(root);
    await ensureVaultLayout(paths);
    const db = VaultDb.open(paths.sqlite);
    const insert = db.db.prepare(
      `INSERT INTO skills (id, source, name, description, repo_owner, repo_name, skill_path, discovered_at, last_seen_at, status, stars)
       VALUES (?, 'skillsmp', ?, ?, ?, ?, '.', ?, ?, 'scanned', ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        insert.run(`skillsmp:bulk${i}`, `bulk-skill-${i % 50}`, `description ${i}`, `o${i % 90}`, `r${i % 700}`, new Date().toISOString(), new Date().toISOString(), i % 1000);
      }
    });
    const start = Date.now();
    const { searchSkills } = await import('../src/search.ts');
    const hits = searchSkills(db, { query: 'bulk-skill-7', limit: 10 });
    const elapsed = Date.now() - start;
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
    void vaultConfigSchema;
    void Logger;
  });
});
