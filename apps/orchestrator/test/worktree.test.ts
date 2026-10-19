import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workspaces } from '@aik/db';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { WorktreeManager } from '../src/git/worktree.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { assertInTemp, makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('WorktreeManager', () => {
  test('creates and cleans up an isolated story worktree', async () => {
    const repoPath = makeTempRepo({ name: 'main-repo' });
    const worktreeRoot = makeTempDir('aikanban-test-wt-');

    const manager = new WorktreeManager({ rootDir: worktreeRoot });

    const { worktreePath, branch } = await manager.ensureStoryWorktree({
      repoPath,
      storyKey: 'INV-42',
      baseBranch: 'main',
    });

    expect(branch).toBe('story/INV-42');
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);

    // Editing in worktree does not affect main repo working directory
    fs.writeFileSync(path.join(worktreePath, 'new-file.txt'), 'hello worktree');
    expect(fs.existsSync(path.join(repoPath, 'new-file.txt'))).toBe(false);

    // Cleanup never discards uncommitted work: the dirty worktree is preserved.
    const dirty = await manager.removeStoryWorktree({ repoPath, storyKey: 'INV-42' });
    expect(dirty).toEqual({ removed: false, reason: 'dirty' });
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'new-file.txt'))).toBe(true);

    // Once the worktree is clean again, removal succeeds without --force.
    fs.rmSync(path.join(worktreePath, 'new-file.txt'));
    const clean = await manager.removeStoryWorktree({ repoPath, storyKey: 'INV-42' });
    expect(clean).toEqual({ removed: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test('removes a clean story worktree and deletes its merged branch', async () => {
    const repoPath = makeTempRepo({ name: 'main-repo' });
    const manager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-wt-') });

    const { worktreePath } = await manager.ensureStoryWorktree({ repoPath, storyKey: 'INV-43', baseBranch: 'main' });

    const result = await manager.removeStoryWorktree({ repoPath, storyKey: 'INV-43' });

    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
    assertInTemp(repoPath);
    expect(execFileSync('git', ['branch', '--list', 'story/INV-43'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe('');
  });

  test('marks the workspace row preserved when a dirty story worktree is kept', async () => {
    const repoPath = makeTempRepo({ name: 'main-repo' });
    const o = createTestDb();
    try {
      const project = seedProject(o.db);
      const story = seedStory(o.db, project.id);
      const manager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-wt-'), db: o.db });

      const { worktreePath } = await manager.ensureStoryWorktree({
        repoPath,
        storyKey: 'INV-44',
        baseBranch: 'main',
        storyId: story.id,
      });

      fs.writeFileSync(path.join(worktreePath, 'unique.txt'), 'do not lose me');
      const result = await manager.removeStoryWorktree({ repoPath, storyKey: 'INV-44' });

      expect(result).toEqual({ removed: false, reason: 'dirty' });
      expect(fs.existsSync(worktreePath)).toBe(true);
      const row = o.db.select().from(workspaces).where(eq(workspaces.path, worktreePath)).get();
      expect(row?.status).toBe('preserved');
    } finally {
      o.close();
    }
  });

  test('creates and removes a detached post-merge worktree at the merged SHA', async () => {
    const repoPath = makeTempRepo({ name: 'main-repo' });
    assertInTemp(repoPath);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
    const manager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-wt-') });

    const worktreePath = await manager.ensurePostMergeWorktree({ repoPath, storyKey: 'INV-45', sha, storyId: 1 });

    expect(path.basename(worktreePath)).toBe('INV-45.post');
    expect(fs.existsSync(worktreePath)).toBe(true);
    assertInTemp(worktreePath);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim()).toBe(sha);
    // Detached HEAD: symbolic-ref fails when HEAD is not a branch.
    expect(() => execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' })).toThrow();

    await manager.removePostMergeWorktree({ repoPath, storyKey: 'INV-45' });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test('refuses path traversal outside worktree root', async () => {
    const worktreeRoot = makeTempDir('aikanban-test-wt-');
    const manager = new WorktreeManager({ rootDir: worktreeRoot });

    await expect(
      manager.ensureStoryWorktree({
        repoPath: makeTempRepo(),
        storyKey: '../evil-story',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/invalid story key/i);
  });
});
