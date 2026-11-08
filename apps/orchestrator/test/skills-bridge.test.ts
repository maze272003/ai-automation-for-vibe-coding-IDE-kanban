import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';
import { SkillBridgeService } from '../src/skills/bridge.ts';
import { VaultDb, ensureVaultLayout, skillDirFor, vaultPaths, type VaultPaths } from '@aik/skill-vault';

const WRITING_PLANS_BODY =
  '---\nname: writing-plans\ndescription: Writing implementation plans\n---\n# Writing plans\nBreak the story into verifiable subtasks before writing code.\n';
const REACT_FORMS_BODY =
  '---\nname: react-forms\ndescription: Patterns for building signup forms in React\n---\n# React forms\nUse controlled components and explicit validation for form state.\n';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface SeedSkill {
  id: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  status?: string;
  body: string;
}

async function makeVault(): Promise<{ vaultRoot: string; paths: VaultPaths; db: VaultDb }> {
  const vaultRoot = makeTempDir('mock-vault-');
  const paths = vaultPaths(vaultRoot);
  await ensureVaultLayout(paths);
  return { vaultRoot, paths, db: VaultDb.open(paths.sqlite) };
}

/** Insert a raw vault row (snake_case SkillRow) plus its SKILL.md at the skill's content dir. */
async function seedSkill(db: VaultDb, paths: VaultPaths, skill: SeedSkill): Promise<void> {
  const status = skill.status ?? 'approved';
  const dir = skillDirFor(paths, {
    repo_owner: skill.owner,
    repo_name: skill.repo,
    skill_path: '.',
    name: skill.name,
    status,
  });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), skill.body, 'utf8');
  const iso = new Date().toISOString();
  db.db
    .prepare(
      `INSERT INTO skills (id, source, name, description, repo_owner, repo_name, skill_path, status, content_sha256, discovered_at, last_seen_at)
       VALUES (?, 'test', ?, ?, ?, ?, '.', ?, ?, ?, ?)`,
    )
    .run(skill.id, skill.name, skill.description, skill.owner, skill.repo, status, `mock-${skill.name}`, iso, iso);
}

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
    expect(result.delivered).toEqual([]);
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

  test('delivers role defaults first, then matching approved recommendations, inline', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const { vaultRoot, paths, db } = await makeVault();
    await seedSkill(db, paths, {
      id: 'gh:obra/superpowers/writing-plans',
      name: 'writing-plans',
      description: 'Writing implementation plans',
      owner: 'obra',
      repo: 'superpowers',
      body: WRITING_PLANS_BODY,
    });
    await seedSkill(db, paths, {
      id: 'gh:react-community/react-forms/react-forms',
      name: 'react-forms',
      description: 'Patterns for building signup forms in React',
      owner: 'react-community',
      repo: 'react-forms',
      body: REACT_FORMS_BODY,
    });
    await seedSkill(db, paths, {
      id: 'gh:evil-corp/evil-skills/react-evil',
      name: 'react-evil',
      description: 'React signup form helper',
      owner: 'evil-corp',
      repo: 'evil-skills',
      status: 'quarantined',
      body: '# Do suspicious things\n',
    });
    db.close();

    const bridge = new SkillBridgeService({ vaultRoot });
    const result = await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'planner',
      storyTitle: 'Add a signup form with React',
      storyDescription: 'Build a signup form with React hooks.',
      repoPath: repoDir,
      isWorktree: false,
    });

    // Role default first, repo-matched recommendation second.
    expect(result.delivered.map((s) => s.name)).toEqual(['writing-plans', 'react-forms']);
    expect(result.delivered[0]).toMatchObject({
      id: 'gh:obra/superpowers/writing-plans',
      contentSha256: sha256(WRITING_PLANS_BODY),
      bytes: Buffer.byteLength(WRITING_PLANS_BODY, 'utf8'),
    });
    expect(result.delivered[1]).toMatchObject({ contentSha256: sha256(REACT_FORMS_BODY) });

    expect(result.promptHint.split('\n')[0]).toBe('SKILLS — follow these when they apply to the task:');
    expect(result.promptHint).toContain('=== SKILL: writing-plans ===');
    expect(result.promptHint).toContain(WRITING_PLANS_BODY);
    expect(result.promptHint.indexOf('=== SKILL: writing-plans ===')).toBeLessThan(
      result.promptHint.indexOf('=== SKILL: react-forms ==='),
    );
    expect(result.promptHint).toContain('=== SKILL: react-forms ===');
    expect(result.promptHint).toContain(REACT_FORMS_BODY);
    expect(result.promptHint).toContain('=== END SKILL ===');

    // Quarantined vault content is never delivered, even when it matches the story.
    expect(result.delivered.map((s) => s.id)).not.toContain('gh:evil-corp/evil-skills/react-evil');
    expect(result.promptHint).not.toContain('react-evil');
  });

  test('skips a 20 KB skill that busts the delivery budget but delivers a later smaller one', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const { vaultRoot, paths, db } = await makeVault();
    await seedSkill(db, paths, {
      id: 'gh:obra/superpowers/writing-plans',
      name: 'writing-plans',
      description: 'Writing implementation plans',
      owner: 'obra',
      repo: 'superpowers',
      body: WRITING_PLANS_BODY,
    });
    await seedSkill(db, paths, {
      id: 'gh:acme/wizard/signup-master',
      name: 'signup-master',
      description: 'Guided signup wizard flow',
      owner: 'acme',
      repo: 'wizard',
      body: 'x'.repeat(20_480),
    });
    await seedSkill(db, paths, {
      id: 'gh:acme-lite/forms-lite/forms-lite',
      name: 'forms-lite',
      description: 'Small form input helper',
      owner: 'acme-lite',
      repo: 'forms-lite',
      body: 'y'.repeat(1_024),
    });
    db.close();

    const bridge = new SkillBridgeService({ vaultRoot });
    const result = await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'planner',
      storyTitle: 'Add a signup form with React',
      repoPath: repoDir,
      isWorktree: false,
    });

    expect(result.delivered.map((s) => s.name)).toEqual(['writing-plans', 'forms-lite']);
    expect(result.delivered[1]).toMatchObject({ bytes: 1_024, contentSha256: sha256('y'.repeat(1_024)) });
    expect(result.promptHint).not.toContain('=== SKILL: signup-master ===');
    expect(result.promptHint).toContain('=== SKILL: forms-lite ===');
  });

  test('installs approved role-baseline skills, delivers the body inline, and cleans up', async () => {
    const repoDir = makeTempRepo({ name: 'test-repo' });
    const { vaultRoot, paths, db } = await makeVault();
    await seedSkill(db, paths, {
      id: 'gh:obra/superpowers/writing-plans',
      name: 'writing-plans',
      description: 'Writing implementation plans',
      owner: 'obra',
      repo: 'superpowers',
      body: WRITING_PLANS_BODY,
    });
    db.close();

    const bridge = new SkillBridgeService({ vaultRoot });
    const result = await bridge.injectSkills({
      targetDirectory: repoDir,
      role: 'planner',
      storyTitle: 'Story planning',
      repoPath: repoDir,
      isWorktree: false,
    });

    expect(result.injected).toHaveLength(1);
    expect(result.injected[0]?.installName).toBe('writing-plans');
    expect(result.delivered).toHaveLength(1);
    expect(result.promptHint).toContain('=== SKILL: writing-plans ===');
    expect(result.promptHint).toContain('# Writing plans');

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
