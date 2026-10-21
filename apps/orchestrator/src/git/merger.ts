import { ProjectSettings } from '@aik/contracts';
import { mergeApprovals, merges, projects, userStories, verificationChecks, type AikDb } from '@aik/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import type { EventBus } from '../events/bus.ts';
import { systemClock, type Clock } from '../time.ts';
import type { VerificationRunner } from '../verify/runner.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { WorktreeManager } from './worktree.ts';

export interface LocalMergerDeps {
  db: AikDb;
  workflow: WorkflowService;
  bus: EventBus;
  worktreeManager: WorktreeManager;
  verification: VerificationRunner;
  now?: Clock;
  /** Applied to every persisted/returned git output snippet (repo policy: persisted process output is redacted). */
  redact?: (text: string) => string;
}

export interface ApproveAndMergeStoryInput {
  storyId: number;
  approver?: string;
  note?: string;
  /**
   * Lease gate for the merge job: returns false once this job no longer holds the story's merge
   * lease. Checked before every state-changing step; a false result stops the merge without
   * transitioning the story and without advancing the base ref (spec I9).
   */
  assertLease?: () => boolean;
}

export interface MergeResult {
  ok: boolean;
  mergedSha?: string;
  /** The base moved, so the story went back to TESTING with a refreshed candidate. */
  reverificationRequired?: boolean;
  /** Non-fatal outcome notice, e.g. a dirty story worktree that was intentionally kept (spec §13.6). */
  warning?: string;
  error?: string;
}

export interface RevertResult {
  ok: boolean;
  revertSha?: string;
  error?: string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

/** Runs git without throwing so that meaningful non-zero exits (e.g. merge conflicts) can be inspected. */
const runGit = (cwd: string, args: string[]): { code: number; output: string } => {
  try {
    return { code: 0, output: execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const text = (b: string | Buffer | undefined): string => (typeof b === 'string' ? b : (b?.toString('utf8') ?? ''));
    return { code: typeof e.status === 'number' ? e.status : -1, output: `${text(e.stdout)}${text(e.stderr)}` };
  }
};

/** One-line, size-limited rendering of git output for error messages. */
const brief = (text: string, max = 300): string => {
  const t = text.replace(/\0/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

/** The paths `git merge-tree --write-tree` reported as conflicted, when cheaply available. */
const conflictedPaths = (output: string): string[] => {
  const paths = new Set<string>();
  for (const m of output.matchAll(/CONFLICT \([^)]*\):[^\r\n]*? in (.+?)(?:\s*(?:\0|\r?\n)|\s*$)/g)) {
    if (m[1] !== undefined) paths.add(m[1]);
  }
  if (paths.size === 0) {
    // Conflicted file info section: `<mode> <object> <stage>\t<path>`
    for (const m of output.matchAll(/^\d{6} [0-9a-f]{40,64} [123]\t(.+?)\s*$/gm)) {
      if (m[1] !== undefined) paths.add(m[1]);
    }
  }
  return [...paths];
};

const leaseLost = (step: string): string => `The merge job lease was lost; the merge stopped before ${step}`;

/** Local merge pipeline (spec §13.5, EXE-14). Never runs without a human approval for the exact candidate. */
export class LocalMerger {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly worktreeManager: WorktreeManager;
  private readonly verification: VerificationRunner;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;

  constructor(deps: LocalMergerDeps) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.worktreeManager = deps.worktreeManager;
    this.verification = deps.verification;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
  }

  async approveAndMergeStory(input: ApproveAndMergeStoryInput): Promise<MergeResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, input.storyId)).get();
    if (!story) return { ok: false, error: `Story ${input.storyId} not found` };
    if (story.status !== 'AWAITING_MERGE' || !story.candidateSha) {
      return { ok: false, error: `Story ${story.key} is not in AWAITING_MERGE or lacks a candidate SHA` };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: `Project for story ${story.key} not found` };
    const settings = ProjectSettings.parse(project.settings);

    const candidate = story.candidateSha;
    const approval = this.db
      .select()
      .from(mergeApprovals)
      .where(
        and(
          eq(mergeApprovals.storyId, story.id),
          eq(mergeApprovals.kind, 'merge'),
          eq(mergeApprovals.commitSha, candidate),
        ),
      )
      .get();
    if (!approval) {
      return { ok: false, error: `There is no human merge approval for candidate ${candidate}` };
    }

    const baseRef = `refs/heads/${project.baseBranch}`;
    let baseBefore: string;
    try {
      baseBefore = git(project.repoPath, 'rev-parse', baseRef);
      git(project.repoPath, 'cat-file', '-e', `${candidate}^{commit}`);
    } catch (err) {
      return { ok: false, error: `Cannot resolve the base branch or candidate: ${String(err)}` };
    }

    // 1. If the base moved, merge it into the story branch and re-verify the new candidate (T11).
    if (!isAncestor(project.repoPath, baseBefore, candidate)) {
      if (this.lostLease(input)) return { ok: false, error: leaseLost('synchronizing the base') };
      return this.syncBase({ storyId: story.id, storyKey: story.key, candidate, baseBefore, project });
    }

    // 2. Refuse a dirty checked-out base before creating any commit (spec §13.5).
    const baseWorktree = this.findWorktreeForBranch(project.repoPath, baseRef);
    if (baseWorktree) {
      let dirty: string;
      try {
        dirty = git(baseWorktree, 'status', '--porcelain');
      } catch {
        dirty = 'unknown';
      }
      if (dirty) {
        return {
          ok: false,
          error: `Commit or stash your changes in ${baseWorktree}, then retry`,
        };
      }
      const head = git(baseWorktree, 'rev-parse', 'HEAD');
      if (head !== baseBefore) {
        return { ok: false, error: `The base branch moved while preparing the merge (${baseBefore} → ${head}); retry` };
      }
    }

    // 3. Build the result without touching a working tree (spec §13.5 step 2).
    if (this.lostLease(input)) {
      return { ok: false, error: leaseLost('creating the merged commit') };
    }
    const probe = runGit(project.repoPath, ['merge-tree', '--write-tree', baseBefore, candidate]);
    if (probe.code !== 0) {
      if (/CONFLICT/i.test(probe.output)) {
        return this.conflict(story.id, conflictedPaths(probe.output));
      }
      return { ok: false, error: this.gitFailure(`merge-tree exited with code ${probe.code}`, probe.output) };
    }
    const tree = (probe.output.split(/\r?\n/)[0] ?? '').trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) {
      return { ok: false, error: `Git merge failed: merge-tree returned ${this.redact(brief(tree))}` };
    }

    const isSquash = settings.mergeMethod === 'squash';
    let mergedSha: string;
    let mergedTree: string;
    try {
      const parents = isSquash ? ['-p', baseBefore] : ['-p', baseBefore, '-p', candidate];
      const message = isSquash
        ? `feat(${story.key}): ${story.title}\n\nCandidate: ${candidate}`
        : `Merge ${story.key}: ${story.title}\n\nCandidate: ${candidate}`;
      mergedSha = git(
        project.repoPath,
        '-c', 'user.name=AI Kanban Agent',
        '-c', 'user.email=agent@localhost',
        'commit-tree', tree, ...parents, '-m', message,
      );
      mergedTree = git(project.repoPath, 'rev-parse', `${mergedSha}^{tree}`);
    } catch (err) {
      return { ok: false, error: this.gitFailure('merge-tree/commit-tree', err) };
    }

    // Containment proof BEFORE the ref moves and before any merge evidence exists (spec §16 T10, I1):
    // the merged tree must equal the approved candidate tree; a merge commit must additionally contain
    // the candidate by ancestry. For a squash merge the tree equality alone is the proof.
    if (mergedTree !== story.candidateTree) {
      return {
        ok: false,
        error: `The merged tree ${mergedTree} does not match the approved candidate tree ${story.candidateTree}; the base branch was not advanced`,
      };
    }
    if (!isSquash && !isAncestor(project.repoPath, candidate, mergedSha)) {
      return {
        ok: false,
        error: `The merged commit ${mergedSha} does not contain the approved candidate ${candidate}; the base branch was not advanced`,
      };
    }

    const mergeRow = this.db
      .insert(merges)
      .values({
        storyId: story.id,
        method: isSquash ? 'local_squash' : 'local_merge',
        approvedSha: candidate,
        baseBefore,
        status: 'running',
        startedAt: new Date(this.now()),
      })
      .returning()
      .get();

    // 4. Advance the base ref safely (update-ref CAS, or fast-forward a clean checkout).
    if (this.lostLease(input)) {
      const error = leaseLost('advancing the base ref');
      this.db
        .update(merges)
        .set({ status: 'failed', error, endedAt: new Date(this.now()) })
        .where(eq(merges.id, mergeRow.id))
        .run();
      return { ok: false, error };
    }
    try {
      if (baseWorktree) {
        git(baseWorktree, 'merge', '--ff-only', mergedSha);
        if (git(baseWorktree, 'rev-parse', 'HEAD') !== mergedSha) throw new Error('The base checkout did not fast-forward');
      } else {
        git(project.repoPath, 'update-ref', baseRef, mergedSha, baseBefore);
      }
    } catch (err) {
      this.db
        .update(merges)
        .set({ status: 'failed', error: this.redact(String(err)), endedAt: new Date(this.now()) })
        .where(eq(merges.id, mergeRow.id))
        .run();
      return { ok: false, error: `Could not advance ${project.baseBranch}: ${this.redact(String(err))}` };
    }

    this.db
      .update(merges)
      .set({ status: 'succeeded', mergedSha, baseAfter: mergedSha, endedAt: new Date(this.now()) })
      .where(eq(merges.id, mergeRow.id))
      .run();

    // 5. Post-merge mandatory checks on the exact merged SHA; DONE is unreachable without them (I1).
    if (this.lostLease(input)) {
      return { ok: false, error: leaseLost('post-merge verification') };
    }
    const verification = await this.verification.verifyPostMerge({ storyId: story.id, mergedSha });
    if (!verification.ok) {
      const failed = verification.verificationRunId
        ? this.db
            .select({ key: verificationChecks.checkKey, status: verificationChecks.status })
            .from(verificationChecks)
            .where(
              and(
                eq(verificationChecks.verificationRunId, verification.verificationRunId),
                inArray(verificationChecks.status, ['failed', 'timed_out', 'error', 'unsupported']),
              ),
            )
            .all()
        : [];
      const detail = failed.length
        ? `Post-merge checks failed: ${failed.map((f) => `${f.key} (${f.status})`).join(', ')}`
        : verification.error ?? 'Post-merge verification did not pass';
      this.workflow.transition({
        storyId: story.id,
        event: { type: 'fail', reason: 'post_merge_failed', detail },
        actor: 'system',
      });
      this.bus.notify(1);
      return { ok: false, error: detail };
    }

    if (this.lostLease(input)) {
      return { ok: false, error: leaseLost('the merge_completed transition') };
    }
    const transition = this.workflow.transition({
      storyId: story.id,
      event: { type: 'merge_completed', mergedSha },
      actor: 'system',
    });
    if (!transition.ok) {
      return {
        ok: false,
        error: `Transition to DONE failed: ${transition.failedGuards?.map((g) => g.reason).join('; ') ?? transition.code}`,
      };
    }

    // 6. The story is DONE and the worktree is clean; remove it without ever forcing (spec §13.6).
    // A refused cleanup is never a failed merge: the worktree is kept on purpose and reported.
    const cleanup = await this.worktreeManager.removeStoryWorktree({ repoPath: project.repoPath, storyKey: story.key });
    this.bus.notify(1);
    return cleanup.removed
      ? { ok: true, mergedSha }
      : { ok: true, mergedSha, warning: `story worktree kept: ${cleanup.reason ?? 'unknown reason'}` };
  }

  /** Base sync: keep the approved candidate's changes, create a new candidate, and return to TESTING. */
  private async syncBase(input: {
    storyId: number;
    storyKey: string;
    candidate: string;
    baseBefore: string;
    project: typeof projects.$inferSelect;
  }): Promise<MergeResult> {
    const { storyId, storyKey, candidate, baseBefore, project } = input;
    const { worktreePath } = await this.worktreeManager.ensureStoryWorktree({
      repoPath: project.repoPath,
      storyKey,
      baseBranch: project.baseBranch,
      storyId,
    });
    if (git(worktreePath, 'rev-parse', 'HEAD') !== candidate) {
      return { ok: false, error: 'The story worktree is not at the approved candidate; retry after it is idle' };
    }
    if (git(worktreePath, 'status', '--porcelain')) {
      return { ok: false, error: 'The story worktree has uncommitted changes; retry after they are resolved' };
    }

    // Detect the conflict explicitly before touching the worktree (spec §6.10): merge-tree exits
    // non-zero and prints CONFLICT when the moved base and the candidate cannot be merged.
    const probe = runGit(project.repoPath, ['merge-tree', '--write-tree', baseBefore, candidate]);
    if (probe.code !== 0) {
      if (/CONFLICT/i.test(probe.output)) return this.conflict(storyId, conflictedPaths(probe.output));
      return { ok: false, error: `Base sync failed: ${this.gitFailure(`merge-tree exited with code ${probe.code}`, probe.output)}` };
    }

    try {
      git(
        worktreePath,
        '-c', 'user.name=AI Kanban Agent',
        '-c', 'user.email=agent@localhost',
        'merge', '--no-edit', baseBefore,
      );
    } catch {
      try {
        git(worktreePath, 'merge', '--abort');
      } catch {
        // nothing to abort
      }
      return this.conflict(storyId, []);
    }

    const newSha = git(worktreePath, 'rev-parse', 'HEAD');
    const newTree = git(worktreePath, 'rev-parse', 'HEAD^{tree}');
    if (newSha === candidate) {
      return { ok: false, error: 'Base sync produced no new candidate; retry' };
    }
    const transition = this.workflow.transition({
      storyId,
      event: { type: 'candidate_head_changed', newSha, newTree },
      actor: 'system',
    });
    if (!transition.ok) {
      return {
        ok: false,
        error: `Base sync could not return the story to TESTING: ${transition.failedGuards?.map((g) => g.reason).join('; ') ?? transition.code}`,
      };
    }
    this.bus.notify(1);
    return { ok: true, reverificationRequired: true };
  }

  /**
   * Reverts a merge commit whose post-merge checks failed (spec §13.5 step 4, §6.10 row 3, §21 S8).
   * Started by the human when the story is BLOCKED(post_merge_failed).
   */
  async revertFailedMerge(input: { storyId: number }): Promise<RevertResult> {
    const story = this.db.select().from(userStories).where(eq(userStories.id, input.storyId)).get();
    if (!story) return { ok: false, error: 'Story not found' };
    if (story.status !== 'BLOCKED' || story.blockedReason !== 'post_merge_failed') {
      return {
        ok: false,
        error: `Story is not in BLOCKED(post_merge_failed) status (current: ${story.status}${story.blockedReason ? `/${story.blockedReason}` : ''})`,
      };
    }

    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
    if (!project) return { ok: false, error: 'Project not found' };

    const mergeRow = this.db
      .select()
      .from(merges)
      .where(and(eq(merges.storyId, story.id), eq(merges.status, 'succeeded')))
      .orderBy(desc(merges.id))
      .limit(1)
      .get();
    if (!mergeRow || !mergeRow.mergedSha || !mergeRow.baseBefore) {
      return { ok: false, error: 'Could not find the merge record to revert' };
    }

    const mergedSha = mergeRow.mergedSha;
    const baseBefore = mergeRow.baseBefore;
    const baseRef = `refs/heads/${project.baseBranch}`;

    let baseHead: string;
    try {
      baseHead = git(project.repoPath, 'rev-parse', baseRef);
    } catch (err) {
      return { ok: false, error: `Cannot resolve base branch ${project.baseBranch}: ${String(err)}` };
    }

    if (!isAncestor(project.repoPath, mergedSha, baseHead)) {
      return { ok: false, error: `The base branch does not contain the merged commit ${mergedSha}` };
    }

    // Refuse a dirty checked-out base before creating any commit (spec §13.5).
    const baseWorktree = this.findWorktreeForBranch(project.repoPath, baseRef);
    if (baseWorktree) {
      let dirty: string;
      try {
        dirty = git(baseWorktree, 'status', '--porcelain');
      } catch {
        dirty = 'unknown';
      }
      if (dirty) {
        return {
          ok: false,
          error: `Commit or stash your changes in ${baseWorktree}, then retry`,
        };
      }
      const head = git(baseWorktree, 'rev-parse', 'HEAD');
      if (head !== baseHead) {
        return { ok: false, error: `The base branch moved while preparing the revert (${baseHead} → ${head}); retry` };
      }
    }

    // Tree-less 3-way revert using git merge-tree
    const probe = runGit(project.repoPath, [
      'merge-tree',
      '--write-tree',
      `--merge-base=${mergedSha}`,
      baseHead,
      baseBefore,
    ]);
    if (probe.code !== 0) {
      return { ok: false, error: this.gitFailure(`merge-tree revert exited with code ${probe.code}`, probe.output) };
    }

    const revertTree = (probe.output.split(/\r?\n/)[0] ?? '').trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revertTree)) {
      return { ok: false, error: `Git revert failed: merge-tree returned ${this.redact(brief(revertTree))}` };
    }

    let revertSha: string;
    try {
      const message = `Revert "Merge ${story.key}: ${story.title}"\n\nThis reverts commit ${mergedSha} due to post-merge check failures.`;
      revertSha = git(
        project.repoPath,
        '-c', 'user.name=AI Kanban Agent',
        '-c', 'user.email=agent@localhost',
        'commit-tree', revertTree, '-p', baseHead, '-m', message,
      );
    } catch (err) {
      return { ok: false, error: this.gitFailure('revert commit-tree', err) };
    }

    // Advance the base ref safely (update-ref CAS, or fast-forward clean checkout)
    try {
      if (baseWorktree) {
        git(baseWorktree, 'merge', '--ff-only', revertSha);
        if (git(baseWorktree, 'rev-parse', 'HEAD') !== revertSha) throw new Error('The base checkout did not fast-forward');
      } else {
        git(project.repoPath, 'update-ref', baseRef, revertSha, baseHead);
      }
    } catch (err) {
      return { ok: false, error: `Could not advance ${project.baseBranch}: ${this.redact(String(err))}` };
    }

    // Update story detail to note revert commit and bump statusVersion
    this.db
      .update(userStories)
      .set({
        blockedDetail: `Post-merge checks failed. Reverted on ${project.baseBranch} via ${revertSha}.`,
        statusVersion: story.statusVersion + 1,
        updatedAt: new Date(this.now()),
      })
      .where(eq(userStories.id, story.id))
      .run();

    this.bus.notify(1);
    return { ok: true, revertSha };
  }

  /**
   * Records a merge conflict (spec §6.10, §13.5 step 1): AWAITING_MERGE → REWORK (T12) while attempts
   * remain, otherwise BLOCKED(conflict) via T13. The story never silently stays AWAITING_MERGE.
   */
  private conflict(storyId: number, paths: string[]): MergeResult {
    const detail = paths.length
      ? `The moved base conflicts with the approved candidate in: ${paths.join(', ')}`
      : 'The moved base conflicts with the approved candidate';
    const rework = this.workflow.transition({ storyId, event: { type: 'merge_conflict' }, actor: 'system' });
    if (rework.ok) {
      this.bus.notify(1);
      return { ok: false, error: detail };
    }
    const blocked = this.workflow.transition({ storyId, event: { type: 'fail', reason: 'conflict', detail }, actor: 'system' });
    if (blocked.ok) {
      this.bus.notify(1);
      return { ok: false, error: `${detail}. The attempt budget is exhausted, so the story is BLOCKED (conflict)` };
    }
    return {
      ok: false,
      error: `${detail}. The story is still AWAITING_MERGE because the transition failed: ${
        rework.failedGuards?.map((g) => g.reason).join('; ') ?? rework.code
      }`,
    };
  }

  /** True when the merge job's lease assertion says this job no longer owns the story (spec I9). */
  private lostLease(input: ApproveAndMergeStoryInput): boolean {
    return input.assertLease !== undefined && !input.assertLease();
  }

  /** Redacted rendering of a git failure for messages and persisted error columns. */
  private gitFailure(what: string, detail: unknown): string {
    const text = typeof detail === 'string' ? detail : String(detail);
    return `Git merge failed: ${what}: ${this.redact(brief(text))}`;
  }

  /** Finds the checkout that has `branchRef` checked out, if any (spec §13.5 step 3). */
  private findWorktreeForBranch(repoPath: string, branchRef: string): string | null {
    const listing = git(repoPath, 'worktree', 'list', '--porcelain');
    let current: string | null = null;
    for (const line of listing.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
      else if (line === `branch ${branchRef}` && current) return current;
    }
    return null;
  }
}
