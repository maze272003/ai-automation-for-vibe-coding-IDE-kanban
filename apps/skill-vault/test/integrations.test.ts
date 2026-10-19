// apps/skill-vault/test/integrations.test.ts — agent install/uninstall: conflict safety,
// preservation of existing skills, manifests, dry runs, validation rules.
import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultDb } from '../src/db.ts';
import { Logger } from '../src/log.ts';
import { ensureVaultLayout, skillContentDir, skillDirSlug, vaultPaths, statusHome } from '../src/paths.ts';
import { installSkills, uninstallSkill, validateSkillForAgent } from '../src/integrations.ts';
import { makeTempDir } from './helpers/temp.ts';
import { cleanSkillMd } from './helpers/fixtures.ts';

const setup = async () => {
  const root = makeTempDir();
  const paths = vaultPaths(root);
  await ensureVaultLayout(paths);
  const db = VaultDb.open(paths.sqlite);
  const logger = Logger.silent();
  return { paths, db, logger };
};

const seedApproved = async (paths: ReturnType<typeof vaultPaths>, db: VaultDb, id: string, name: string, owner: string, repo: string, skillMd: string): Promise<void> => {
  const home = statusHome(paths, 'approved');
  const dir = skillContentDir(home, owner, repo, skillDirSlug('.', name));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), skillMd);
  const row = approvedRow(id, name, owner, repo);
  const columns = Object.keys(row).join(', ');
  const placeholders = Object.keys(row).map(() => '?').join(', ');
  db.db.prepare(`INSERT OR REPLACE INTO skills (${columns}) VALUES (${placeholders})`).run(...Object.values(row));
};

const approvedRow = (id: string, name: string, owner: string, repo: string) => ({
  id,
  source: 'skillsmp',
  external_id: id,
  repo_entry_id: null,
  name,
  description: '',
  author: owner,
  repo_owner: owner,
  repo_name: repo,
  repo_url: `https://github.com/${owner}/${repo}`,
  skill_path: '.',
  category: 'coding',
  content_language: 'en',
  stars: 1,
  source_updated_at: null,
  skill_url: '',
  discovered_at: '',
  last_seen_at: '',
  status: 'approved',
  content_sha256: 'abc',
  license: 'MIT',
  license_source: 'license-file',
  downloaded_at: new Date().toISOString(),
  download_commit: 'f'.repeat(40),
  download_ref: 'main',
  dup_of_id: null,
  failure_reason: null,
  file_count: 1,
  size_bytes: 100,
});

describe('skill validation per agent', () => {
  it('enforces shared name/description rules and reports OpenCode-specific notes', () => {
    const good = validateSkillForAgent('opencode', cleanSkillMd('git-release'), 'Fallback');
    expect(good.ok).toBe(true);
    expect(good.installName).toBe('git-release');

    const bad = validateSkillForAgent('opencode', '---\nname: Bad Name\ndescription: x\nargument-hint: y\n---\n', 'Fallback');
    expect(bad.ok).toBe(false);
    expect(bad.installName).toBe('bad-name');
    expect(bad.notes.some((note: string) => note.includes('argument-hint'))).toBe(true);
  });
});

describe('install and uninstall', () => {
  it('installs an approved skill into the project .opencode/skills with a vault marker', async () => {
    const { paths, db, logger } = await setup();
    await seedApproved(paths, db, 'skillsmp:a1', 'Git Release', 'obra', 'superpowers', cleanSkillMd('git-release'));
    const project = makeTempDir('project-');
    const report = await installSkills({ db, paths, logger }, {
      agent: 'opencode',
      scope: 'project',
      targetRoot: project,
      skills: [approvedRow('skillsmp:a1', 'Git Release', 'obra', 'superpowers') as never],
    });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.outcome).toBe('installed');
    const skillMd = await fsp.readFile(path.join(project, '.opencode', 'skills', 'git-release', 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('git-release');
    const marker = JSON.parse(await fsp.readFile(path.join(project, '.opencode', 'skills', 'git-release', 'skill-vault.json'), 'utf8')) as { skill_id: string };
    expect(marker.skill_id).toBe('skillsmp:a1');
    const rows = db.db.prepare('SELECT COUNT(*) AS n FROM integrations').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('refuses to overwrite an existing skill directory it does not manage', async () => {
    const { paths, db, logger } = await setup();
    await seedApproved(paths, db, 'skillsmp:a1', 'Git Release', 'obra', 'superpowers', cleanSkillMd('git-release'));
    const project = makeTempDir('project-');
    const existing = path.join(project, '.opencode', 'skills', 'git-release');
    await fsp.mkdir(existing, { recursive: true });
    await fsp.writeFile(path.join(existing, 'SKILL.md'), 'user-authored content');
    const report = await installSkills({ db, paths, logger }, {
      agent: 'opencode',
      scope: 'project',
      targetRoot: project,
      skills: [approvedRow('skillsmp:a1', 'Git Release', 'obra', 'superpowers') as never],
    });
    expect(report.outcomes[0]?.outcome).toBe('skipped');
    const preserved = await fsp.readFile(path.join(existing, 'SKILL.md'), 'utf8');
    expect(preserved).toBe('user-authored content');
  });

  it('dry-run installs nothing', async () => {
    const { paths, db, logger } = await setup();
    await seedApproved(paths, db, 'skillsmp:a1', 'Git Release', 'obra', 'superpowers', cleanSkillMd('git-release'));
    const project = makeTempDir('project-');
    const report = await installSkills({ db, paths, logger }, {
      agent: 'opencode',
      scope: 'project',
      targetRoot: project,
      skills: [approvedRow('skillsmp:a1', 'Git Release', 'obra', 'superpowers') as never],
      dryRun: true,
    });
    expect(report.outcomes[0]?.outcome).toBe('installed');
    const exists = await fsp.stat(path.join(project, '.opencode')).catch(() => undefined);
    expect(exists).toBeUndefined();
  });

  it('uninstalls only vault-managed files and preserves a neighboring skill', async () => {
    const { paths, db, logger } = await setup();
    await seedApproved(paths, db, 'skillsmp:a1', 'Git Release', 'obra', 'superpowers', cleanSkillMd('git-release'));
    const project = makeTempDir('project-');
    await installSkills({ db, paths, logger }, {
      agent: 'claude-code',
      scope: 'project',
      targetRoot: project,
      skills: [approvedRow('skillsmp:a1', 'Git Release', 'obra', 'superpowers') as never],
    });
    const neighbor = path.join(project, '.claude', 'skills', 'user-skill');
    await fsp.mkdir(neighbor, { recursive: true });
    await fsp.writeFile(path.join(neighbor, 'SKILL.md'), 'user content');
    const results = await uninstallSkill({ db, logger }, { skillId: 'skillsmp:a1' });
    expect(results[0]?.removed).toBe(true);
    const gone = await fsp.stat(path.join(project, '.claude', 'skills', 'git-release')).catch(() => undefined);
    expect(gone).toBeUndefined();
    const kept = await fsp.readFile(path.join(neighbor, 'SKILL.md'), 'utf8');
    expect(kept).toBe('user content');
    const rows = db.db.prepare('SELECT COUNT(*) AS n FROM integrations').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
