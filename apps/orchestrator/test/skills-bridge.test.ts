import { describe, expect, test } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';
import { SkillBridgeService } from '../src/skills/bridge.ts';
import { VaultDb, vaultPaths, ensureVaultLayout } from '@aik/skill-vault';

describe('SkillBridgeService', () => {
  test('gracefully degrades when vault root does not exist', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const vaultRoot = path.join(makeTempDir('vault-nonexistent-'), 'nonexistent');
    const bridge = new SkillBridgeService({ vaultRoot });
    const result = await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'implementer',
      storyTitle: 'Test Story',
      repoPath: repoDir,
      isWorktree: true,
    });
    expect(result.injected).toEqual([]);
    expect(result.promptHint).toBe('');
  });

  test('configures .git/info/exclude in worktree directory', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const vaultRoot = path.join(makeTempDir('vault-nonexistent-'), 'nonexistent');
    const bridge = new SkillBridgeService({ vaultRoot });
    await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'implementer',
      storyTitle: 'Test Story',
      repoPath: repoDir,
      isWorktree: true,
    });

    const excludePath = path.join(repoDir, '.git', 'info', 'exclude');
    const exists = await fsp.stat(excludePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    const content = await fsp.readFile(excludePath, 'utf8');
    expect(content).toContain('.opencode/');
  });

  test('injects approved role-baseline skills and generates prompt hint', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const vaultRoot = makeTempDir('mock-vault-');
    const paths = vaultPaths(vaultRoot);
    await ensureVaultLayout(paths);

    const db = VaultDb.open(paths.sqlite);
    // Insert a mock approved skill in the mock vault
    const skillOwner = 'obra';
    const skillRepo = 'superpowers';
    // Directory slug for skill_path 'skills/writing-plans' is 'skills__writing-plans'
    // See skillDirFor: skillContentDir(statusHome, owner, repo, skillDirSlug(skill_path, name))
    const skillDir = path.join(paths.skillsApproved, skillOwner, skillRepo, 'skills__writing-plans');
    await fsp.mkdir(path.join(skillDir, 'skills', 'writing-plans'), { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'skills', 'writing-plans', 'SKILL.md'),
      '---\nname: writing-plans\ndescription: Writing plans\n---\n# Writing plans\n',
      'utf8',
    );

    db.db.prepare(
      `INSERT INTO skills (id, source, name, repo_owner, repo_name, skill_path, status, content_sha256, discovered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'gh:obra/superpowers/skills/writing-plans',
      'test',
      'writing-plans',
      skillOwner,
      skillRepo,
      'skills/writing-plans',
      'approved',
      'mockhash',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();

    const bridge = new SkillBridgeService({ vaultRoot });
    const result = await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'planner',
      storyTitle: 'Story planning',
      repoPath: repoDir,
      isWorktree: false,
    });

    expect(result.injected.length).toBe(1);
    expect(result.injected[0]?.installName).toBe('writing-plans');
    expect(result.promptHint).toContain('AVAILABLE SKILLS');
    expect(result.promptHint).toContain('writing-plans');

    // Verify SKILL.md is in repoDir/.opencode/skills/writing-plans/
    const installedSkill = path.join(repoDir, '.opencode', 'skills', 'writing-plans', 'SKILL.md');
    const installed = await fsp.stat(installedSkill).then(() => true).catch(() => false);
    expect(installed).toBe(true);

    // Test cleanup
    await bridge.cleanupSkills(repoDir);
    const cleaned = await fsp.stat(installedSkill).then(() => true).catch(() => false);
    expect(cleaned).toBe(false);
  });
});
