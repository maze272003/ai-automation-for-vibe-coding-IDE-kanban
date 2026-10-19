import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeManagerOptions {
  rootDir: string;
}

export interface EnsureWorktreeInput {
  repoPath: string;
  storyKey: string;
  baseBranch: string;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
}

export class WorktreeManager {
  private readonly rootDir: string;

  constructor(opts: WorktreeManagerOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private validateStoryKey(key: string): void {
    if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(key)) {
      throw new Error(`Invalid story key for worktree: ${key}`);
    }
  }

  async ensureStoryWorktree(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = path.resolve(this.rootDir, input.storyKey);
    const branch = `story/${input.storyKey}`;

    if (fs.existsSync(worktreePath)) {
      return { worktreePath, branch };
    }

    // Check if branch already exists in repo
    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: input.repoPath, stdio: 'pipe' });
      branchExists = true;
    } catch {
      // branch does not exist yet
    }

    if (branchExists) {
      execFileSync('git', ['worktree', 'add', worktreePath, branch], {
        cwd: input.repoPath,
        encoding: 'utf8',
      });
    } else {
      execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, input.baseBranch], {
        cwd: input.repoPath,
        encoding: 'utf8',
      });
    }

    return { worktreePath, branch };
  }

  async removeStoryWorktree(input: { repoPath: string; storyKey: string }): Promise<void> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = path.resolve(this.rootDir, input.storyKey);

    if (fs.existsSync(worktreePath)) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: input.repoPath,
          encoding: 'utf8',
        });
      } catch {
        // If git worktree remove fails, remove folder and prune
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: input.repoPath, encoding: 'utf8' });
      } catch {
        // ignore prune errors
      }
    }
  }
}
