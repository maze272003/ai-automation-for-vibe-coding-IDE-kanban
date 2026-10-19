// apps/orchestrator/src/git/worktree.ts
import { workspaces, type AikDb } from '@aik/db';
import { and, eq, ne } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { systemClock, type Clock } from '../time.ts';

export interface WorktreeManagerOptions {
  rootDir: string;
  db?: AikDb;
  now?: Clock;
}

export interface EnsureWorktreeInput {
  repoPath: string;
  storyKey: string;
  baseBranch: string;
  storyId?: number;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  workspaceId?: number;
}

export interface EnsureReviewWorktreeInput {
  repoPath: string;
  storyKey: string;
  sha: string;
  storyId: number;
}

export interface RemoveStoryWorktreeResult {
  removed: boolean;
  reason?: string;
}

export class WorktreeManager {
  private readonly rootDir: string;
  private readonly db?: AikDb;
  private readonly now: Clock;

  constructor(opts: WorktreeManagerOptions) {
    this.rootDir = fs.realpathSync.native(fs.mkdirSync(opts.rootDir, { recursive: true }) ?? opts.rootDir);
    this.db = opts.db;
    this.now = opts.now ?? systemClock;
  }

  private validateStoryKey(key: string): void {
    if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(key)) {
      throw new Error(`Invalid story key for worktree: ${key}`);
    }
  }

  /** The path must resolve inside the worktree root, even through a junction or symlink (spec §13.2.4). */
  private contained(name: string): string {
    const target = path.resolve(this.rootDir, name);
    if (!target.startsWith(this.rootDir + path.sep)) throw new Error(`Worktree path escapes the root: ${target}`);
    if (fs.existsSync(target)) {
      const real = fs.realpathSync.native(target);
      if (!real.startsWith(this.rootDir + path.sep)) throw new Error(`Worktree path resolves outside the root: ${real}`);
    }
    return target;
  }

  private record(
    kind: 'story' | 'review' | 'verify' | 'postmerge',
    storyId: number | undefined,
    worktreePath: string,
    branch: string | null,
    headSha: string | null,
  ): number | undefined {
    if (!this.db || !storyId) return undefined;
    const active = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.path, worktreePath), ne(workspaces.status, 'removed')))
      .get();
    if (active) return active.id;
    const row = this.db
      .insert(workspaces)
      .values({ storyId, kind, path: worktreePath, branch, headSha, status: 'active', createdAt: new Date(this.now()) })
      .returning({ id: workspaces.id })
      .get();
    return row?.id;
  }

  private markRemoved(worktreePath: string): void {
    if (!this.db) return;
    this.db
      .update(workspaces)
      .set({ status: 'removed', removedAt: new Date(this.now()) })
      .where(eq(workspaces.path, worktreePath))
      .run();
  }

  /** Marks the workspace row `preserved` when a dirty story worktree is intentionally kept (spec §13.6). */
  private markPreserved(worktreePath: string): void {
    if (!this.db) return;
    const row = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.path, worktreePath), ne(workspaces.status, 'removed')))
      .get();
    if (!row) return;
    this.db.update(workspaces).set({ status: 'preserved' }).where(eq(workspaces.id, row.id)).run();
  }

  async ensureStoryWorktree(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(input.storyKey);
    const branch = `story/${input.storyKey}`;

    if (fs.existsSync(worktreePath)) {
      const headSha = this.head(worktreePath);
      return { worktreePath, branch, workspaceId: this.record('story', input.storyId, worktreePath, branch, headSha) };
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
      execFileSync('git', ['worktree', 'add', worktreePath, branch], { cwd: input.repoPath, encoding: 'utf8' });
    } else {
      execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, input.baseBranch], {
        cwd: input.repoPath,
        encoding: 'utf8',
      });
    }

    const real = fs.realpathSync.native(worktreePath);
    if (!real.startsWith(this.rootDir + path.sep)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      throw new Error(`Worktree resolved outside the root: ${real}`);
    }
    const headSha = this.head(worktreePath);
    return { worktreePath, branch, workspaceId: this.record('story', input.storyId, worktreePath, branch, headSha) };
  }

  /** Detached review worktree at the exact candidate; tracked files are read-only (spec §13.1, §19.4). */
  async ensureReviewWorktree(input: EnsureReviewWorktreeInput): Promise<string> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(`${input.storyKey}.review`);
    if (fs.existsSync(worktreePath)) await this.removeReviewWorktree({ repoPath: input.repoPath, storyKey: input.storyKey });
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, input.sha], { cwd: input.repoPath, encoding: 'utf8' });
    this.setReadOnly(worktreePath, true);
    this.record('review', input.storyId, worktreePath, null, input.sha);
    return worktreePath;
  }

  async removeReviewWorktree(input: { repoPath: string; storyKey: string }): Promise<void> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(`${input.storyKey}.review`);
    if (!fs.existsSync(worktreePath)) return;
    this.setReadOnly(worktreePath, false);
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      // ignore prune errors
    }
    this.markRemoved(worktreePath);
  }

  /** Detached worktree for post-merge checks at the merged SHA (spec §13.5 step 4). */
  async ensurePostMergeWorktree(input: { repoPath: string; storyKey: string; sha: string; storyId: number }): Promise<string> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(`${input.storyKey}.post`);
    if (fs.existsSync(worktreePath)) await this.removePostMergeWorktree({ repoPath: input.repoPath, storyKey: input.storyKey });
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, input.sha], { cwd: input.repoPath, encoding: 'utf8' });
    this.record('postmerge', input.storyId, worktreePath, null, input.sha);
    return worktreePath;
  }

  async removePostMergeWorktree(input: { repoPath: string; storyKey: string }): Promise<void> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(`${input.storyKey}.post`);
    if (!fs.existsSync(worktreePath)) return;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      // ignore prune errors
    }
    this.markRemoved(worktreePath);
  }

  /**
   * Removes a story worktree only when it is clean (spec §13.6). A dirty or uninspectable worktree
   * is preserved for investigation — its workspace row is marked `preserved` — and discarding it is
   * a separate, explicit user action. Never uses `--force` and never falls back to rm -rf.
   */
  async removeStoryWorktree(input: { repoPath: string; storyKey: string }): Promise<RemoveStoryWorktreeResult> {
    this.validateStoryKey(input.storyKey);
    const worktreePath = this.contained(input.storyKey);

    if (!fs.existsSync(worktreePath)) return { removed: true };
    try {
      if (execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' }).trim()) {
        this.markPreserved(worktreePath);
        return { removed: false, reason: 'dirty' };
      }
    } catch {
      this.markPreserved(worktreePath);
      return { removed: false, reason: 'status-unavailable' }; // not a usable worktree: never delete a directory we cannot inspect
    }
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      return { removed: false, reason: 'remove-failed' }; // removal failed: keep the worktree instead of falling back to rm -rf
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      // ignore prune errors
    }
    try {
      execFileSync('git', ['branch', '-d', `story/${input.storyKey}`], { cwd: input.repoPath, encoding: 'utf8' });
    } catch {
      // the branch is either already gone or not fully merged; keep it
    }
    this.markRemoved(worktreePath);
    return { removed: true };
  }

  private head(cwd: string): string | null {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  }

  private setReadOnly(cwd: string, readOnly: boolean): void {
    let files: string[];
    try {
      files = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch {
      return;
    }
    for (const file of files) {
      try {
        fs.chmodSync(path.join(cwd, file), readOnly ? 0o444 : 0o644);
      } catch {
        // best effort: the review verifies HEAD and tree cleanliness regardless
      }
    }
  }
}
