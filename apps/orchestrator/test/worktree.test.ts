import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { WorktreeManager } from '../src/git/worktree.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

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

    // Cleanup
    await manager.removeStoryWorktree({ repoPath, storyKey: 'INV-42' });
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
