// apps/orchestrator/src/git/view-service.ts
import { type BranchListDTO, type CommitDTO, type CommitFilesDTO, type CommitLogDTO, type GitBranchCheckoutRequest, type GitBranchCreateRequest, type GitDiscardRequest, type GitCommitRequest, type GitStageRequest, type GitStatusDTO } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import type { ProjectService } from '../projects/service.ts';
import { systemClock, type Clock } from '../time.ts';
import { git, GitError, gitWithCredentials, stripCredentials } from './git.ts';
import { parsePorcelainStatus } from './status-parse.ts';

type Project = ReturnType<ProjectService['get']>;

export type GitMutationResult = GitStatusDTO;
const busyErr = (reason: string) => new ApiHttpError(409, 'PROJECT_BUSY', reason);

function gitErrorToApi(err: unknown, fallbackMessage: string): ApiHttpError {
  if (!(err instanceof GitError)) throw err;
  const stderr = stripCredentials(err.stderr ?? '');
  return new ApiHttpError(500, 'INTERNAL', `${fallbackMessage}: ${stderr.slice(0, 400)}`);
}

export class GitViewService {
  private readonly db: AikDb;
  private readonly now: Clock;
  private readonly projects: ProjectService;
  private readonly busy: (projectId: number) => string | null;
  private readonly accessToken: (() => Promise<string | null>) | null;

  constructor(deps: {
    db: AikDb;
    now?: Clock;
    projects: ProjectService;
    busy?: (projectId: number) => string | null;
    accessToken?: () => Promise<string | null>;
  }) {
    this.db = deps.db;
    this.now = deps.now ?? systemClock;
    this.projects = deps.projects;
    this.busy = deps.busy ?? (() => null);
    this.accessToken = deps.accessToken ?? null;
  }

  private project(id: number): Project {
    const p = this.projects.get(id); // 404s when unknown
    if (!fs.existsSync(p.repoPath)) throw new ApiHttpError(409, 'NOT_IN_WORKING_TREE', `Project folder is missing on disk: ${p.repoPath}`);
    return p;
  }

  private async raw(project: Project, args: string[], timeoutMs?: number): Promise<string> {
    try {
      return await git(args, { cwd: project.repoPath, timeoutMs });
    } catch (err) {
      throw gitErrorToApi(err, `git ${args[0]} failed`);
    }
  }

  /** The token only when GitHub creds exist; local remotes run prompt-free plain git (§13.4). */
  private async runner(project: Project): Promise<(args: string[], timeoutMs?: number) => Promise<string>> {
    const std = (args: string[], timeoutMs?: number) => this.raw(project, args, timeoutMs);
    if (!this.accessToken) return std;
    try {
      const tok = await this.accessToken();
      if (!tok) return std;
      return (args, timeoutMs) =>
        gitWithCredentials(args, { cwd: project.repoPath, token: tok, timeoutMs }).catch((e) => {
          const err = e instanceof GitError ? stripCredentials(e.stderr ?? '') : '';
          throw new ApiHttpError(500, 'INTERNAL', `git ${args[0]} failed: ${err.slice(0, 400)}`);
        });
    } catch {
      return std;
    }
  }

  private async headSha(project: Project): Promise<string | null> {
    try {
      return (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: project.repoPath })) || null;
    } catch {
      return null;
    }
  }

  async status(projectId: number): Promise<GitStatusDTO> {
    const project = this.project(projectId);
    const out = await this.raw(project, ['status', '--porcelain=v1', '-z', '--branch']);
    const parsed = parsePorcelainStatus(out);
    // Task 4 brief deviation: untracked files (y='?') belong in `changes` — the brief's own
    // test expects `stray.bin` (untracked) listed there, so only y===' ' is excluded.
    const staged = parsed.files.filter((f) => f.x !== ' ' && f.x !== '?');
    const changes = parsed.files.filter((f) => f.y !== ' ');
    const mergeState = await this.mergeState(project);
    // When an upstream exists porcelain omits the `[ahead/behind]` bracket in the in-sync case;
    // `null` stays reserved for "no upstream", so a sync'd branch reports concrete 0s.
    const ahead = parsed.upstream ? parsed.ahead ?? 0 : null;
    const behind = parsed.upstream ? parsed.behind ?? 0 : null;
    return {
      projectId,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead,
      behind,
      staged,
      changes,
      mergeState,
      agentBusy: this.busy(projectId) !== null,
      headSha: await this.headSha(project),
    };
  }

  private async mergeState(project: Project): Promise<'merge' | 'rebase' | 'none'> {
    try {
      const dir = (await git(['rev-parse', '--absolute-git-dir'], { cwd: project.repoPath })).trim();
      if (fs.existsSync(path.join(dir, 'MERGE_HEAD'))) return 'merge';
      if (fs.existsSync(path.join(dir, 'REBASE_HEAD'))) return 'rebase';
      return 'none';
    } catch {
      return 'none';
    }
  }

  async log(projectId: number, limit = 50): Promise<CommitLogDTO> {
    const project = this.project(projectId);
    const max = Math.min(Math.max(1, Math.floor(limit)), 200);
    const out = await this.raw(project, ['log', `--max-count=${max}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1e']);
    const commits = out
      .split('\x1e')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [sha, short, author, dateIso, subject, parents = ''] = line.split('\x1f');
        return {
          sha: sha!,
          short: short!,
          author: author!,
          dateIso: dateIso!,
          subject: subject!,
          parents: parents ? parents.split(' ') : [],
        } satisfies CommitDTO;
      });
    return { projectId, commits };
  }

  async commitFiles(projectId: number, sha: string): Promise<CommitFilesDTO> {
    const project = this.project(projectId);
    // Unknown sha → 404 NOT_FOUND per the brief's declared interface: verify the sha resolves to a
    // commit first (`--verify --quiet` exits non-zero with no output when it does not).
    const commit = await this.raw(project, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).catch(() => '');
    if (commit.trim() === '') throw new ApiHttpError(404, 'NOT_FOUND', 'Commit not found.');
    // --root: the root commit has no parent, so plain `-r` prints nothing for it.
    const out = await this.raw(project, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', sha]);
    const files = out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [change, ...rest] = l.split('\t');
        return { path: rest.join('\t'), change: (change ?? 'M').charAt(0) as 'A' | 'M' | 'D' | 'R' | 'T' | 'C' };
      });
    return { projectId, sha, files };
  }

  async branches(projectId: number): Promise<BranchListDTO> {
    const project = this.project(projectId);
    const [local, remote, current] = await Promise.all([
      this.raw(project, ['branch', '--format=%(refname:short)']),
      this.raw(project, ['branch', '--remotes', '--format=%(refname:short)']).catch(() => ''),
      this.raw(project, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return { projectId, current: current || null, local: local.split('\n').filter(Boolean), remote: remote.split('\n').filter(Boolean) };
  }

  /** Shared pre-mutation guard: busy project + active merge pause everything except reads. */
  private async assertMutable(projectId: number): Promise<Project> {
    const project = this.project(projectId);
    const reason = this.busy(projectId);
    if (reason) throw busyErr(reason);
    if ((await this.mergeState(project)) !== 'none') {
      throw new ApiHttpError(409, 'MERGE_IN_PROGRESS', 'A merge/rebase is in progress in this repository — resolve it in your terminal, then commit there.');
    }
    return project;
  }

  private resolveInRepo(project: Project, rel: string): string {
    const abs = path.resolve(project.repoPath, rel);
    // A caller-supplied path that does not exist makes `realpathSync` throw a raw ENOENT — map it to
    // the same contract error the containment rejection below uses (§ interface: caller errors are
    // ApiHttpError, never unmapped native failures).
    let real: string;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Path not found in repo: ${rel}`);
    }
    const root = fs.realpathSync.native(project.repoPath);
    if (!(real === root || real.startsWith(root + path.sep))) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Path escapes the repository: ${rel}`);
    }
    return real;
  }

  /**
   * Existence-free safety check for paths Git itself listed in the fresh status: those are
   * repo-relative by construction (a tracked deletion ` D` does not even exist on disk, so the
   * realpath check in {@link resolveInRepo} would wrongly reject it). Still reject empty,
   * absolute, backdrive, or `..`-segment forms before they reach git/fs.
   */
  private assertListedPathSafe(rel: string): void {
    if (rel === '') throw new ApiHttpError(400, 'VALIDATION_FAILED', 'Path must not be empty');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Path escapes the repository: ${rel}`);
    }
  }

  private async add(project: Project, paths: string[], flags: string[] = []): Promise<void> {
    try {
      await git(['add', ...flags, '--', ...paths], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git add failed');
    }
  }

  async stage(projectId: number, body: GitStageRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    // Brief deviation: `GitStageRequest` is a union (`paths` | `all`), so `body.all` needs an `in`
    // guard; and the brief's `['.', '-A']` after `--` fails ('-A' becomes a pathspec there), so the
    // `-A` flag goes before `--`.
    if ('all' in body) await this.add(project, ['.'], ['-A']);
    else await this.add(project, body.paths);
    return this.status(projectId);
  }

  async unstage(projectId: number, body: GitStageRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    try {
      // `in` guard: `body.paths` only exists on one branch of the `GitStageRequest` union.
      if ('paths' in body) await git(['reset', '-q', 'HEAD', '--', ...body.paths], { cwd: project.repoPath });
      else await git(['reset', '-q', 'HEAD'], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git reset failed');
    }
    return this.status(projectId);
  }

  async commit(projectId: number, body: GitCommitRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    if (body.paths) await this.add(project, body.paths);
    const st = await this.status(projectId);
    if (st.staged.length === 0) throw new ApiHttpError(400, 'VALIDATION_FAILED', 'Nothing staged to commit');
    try {
      await git(['commit', '-q', '--no-status', '-F', '-'], { cwd: project.repoPath, input: `${body.message}\n` });
    } catch (err) {
      if (err instanceof GitError && /identity|user\.name|user\.email/i.test(err.stderr ?? '')) {
        throw new ApiHttpError(400, 'IDENTITY_MISSING', 'This repository has no Git identity. Set user.name and user.email in the repo (or globally) and retry.');
      }
      throw gitErrorToApi(err, 'git commit failed');
    }
    return this.status(projectId);
  }

  async discard(projectId: number, body: GitDiscardRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    const st = await this.status(projectId);
    const untracked: string[] = [];
    const tracked: string[] = [];
    // Paths listed in the fresh status (staged/changes) are Git-verified repo-relative and are
    // accepted without on-disk existence — a tracked worktree deletion (` D`) does not exist on
    // disk, so `resolveInRepo`'s realpath check would wrongly reject it. Anything not listed keeps
    // the existence-based containment check ('Path not found in repo' when unresolvable).
    const listed = new Set([...st.staged, ...st.changes].map((f) => f.path));
    for (const p of body.paths) {
      if (listed.has(p)) this.assertListedPathSafe(p);
      else this.resolveInRepo(project, p);
      // Brief deviation: `GitStatusDTO` has no `files` — the brief's duplicated `st.files.find(...)`
      // was meant as the staged/unstaged pair (`staged` | `changes`), matching its Note 1.
      const entry = st.staged.find((f) => f.path === p) ?? st.changes.find((f) => f.path === p);
      if (entry && entry.x === '?' && entry.y === '?') untracked.push(p);
      else tracked.push(p);
    }
    if (untracked.length > 0) {
      // Untracked porcelain directories (`?? dir/`) must be removed recursively; `force` matches the
      // prior single-file rm shape.
      for (const p of untracked) fs.rmSync(this.resolveInRepo(project, p), { recursive: true, force: true });
    }
    if (tracked.length > 0) {
      try {
        await git(['restore', '--', ...tracked], { cwd: project.repoPath });
      } catch (err) {
        throw gitErrorToApi(err, 'git restore failed');
      }
    }
    return this.status(projectId);
  }

  /** Pull/checkout are blocked while the working tree holds uncommitted changes. */
  private async ensureDirty(project: Project, what: string): Promise<void> {
    const out = await this.raw(project, ['status', '--porcelain=v1', '-z']);
    if (out.split('\0').some((f) => f.trimEnd() !== '')) {
      throw new ApiHttpError(409, 'WORKING_TREE_DIRTY', `${what} is blocked while there are uncommitted changes — stage, push or discard them first.`);
    }
  }

  private async requireOrigin(project: Project): Promise<void> {
    try {
      await git(['remote', 'get-url', 'origin'], { cwd: project.repoPath });
    } catch {
      throw new ApiHttpError(409, 'NO_REMOTE', 'This repository has no "origin" remote — add one in your terminal (git remote add origin <url>) to enable sync.');
    }
  }

  async push(projectId: number): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    await this.requireOrigin(project);
    const run = await this.runner(project);
    try {
      // `-u` pins the upstream on the first push so later pull is possible without a refspec.
      await run(['push', '-u', 'origin', 'HEAD'], 120_000);
    } catch (err) {
      throw gitErrorToApi(err, 'git push failed');
    }
    return this.status(projectId);
  }

  async pull(projectId: number): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    await this.requireOrigin(project);
    await this.ensureDirty(project, 'Pull');
    try {
      await git(['rev-parse', '-q', '--verify', '@{u}'], { cwd: project.repoPath });
    } catch {
      throw new ApiHttpError(409, 'NO_REMOTE', 'The current branch has no upstream — push once (Push sets upstream) or pull a specific branch in the terminal.');
    }
    const run = await this.runner(project);
    try {
      await run(['pull', '--ff-only', 'origin'], 120_000);
    } catch (err) {
      // Brief deviation: the existing runner converts every GitError to ApiHttpError (both its
      // plain and credential paths embed the stderr in the message), so the brief's
      // `err instanceof GitError` check could never match here. Detect the fast-forward refusal
      // from the message text instead — same contract, both runner paths.
      if (err instanceof ApiHttpError && /not possible to fast-forward/i.test(err.message)) {
        throw new ApiHttpError(409, 'DIVERGED', 'Pull would need a merge — resolve by rebasing/merging in your terminal, then push or pull again.');
      }
      throw err;
    }
    return this.status(projectId);
  }

  async checkout(projectId: number, body: GitBranchCheckoutRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    const exists = await this.raw(project, ['rev-parse', '--verify', '-q', `refs/heads/${body.name}`]).catch(() => '');
    if (!exists) {
      const remoteOnly = await this.raw(project, ['branch', '--remotes', '--format=%(refname:short)']).catch(() => '');
      if (remoteOnly.split('\n').includes(body.name)) {
        throw new ApiHttpError(400, 'BRANCH_INVALID', `"${body.name}" exists only on the remote — switch to its local twin or create it first.`);
      }
      throw new ApiHttpError(400, 'BRANCH_INVALID', `No local branch named "${body.name}".`);
    }
    await this.ensureDirty(project, `Switching to ${body.name}`);
    try {
      await git(['checkout', body.name], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git checkout failed');
    }
    return this.status(projectId);
  }

  async createBranch(projectId: number, body: GitBranchCreateRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    try {
      await git(['check-ref-format', '--branch', body.name], { cwd: project.repoPath });
    } catch {
      throw new ApiHttpError(400, 'BRANCH_INVALID', `"${body.name}" is not a valid branch name.`);
    }
    const exists = await this.raw(project, ['rev-parse', '--verify', '-q', `refs/heads/${body.name}`]).catch(() => '');
    if (exists) throw new ApiHttpError(400, 'BRANCH_INVALID', `Branch "${body.name}" already exists.`);
    // Branching from a different start point must not stomp a dirty tree:
    // branching from the current HEAD never touches the working tree, so the dirty
    // check only applies when `from` points elsewhere. An unresolvable start point
    // must surface as 400 BRANCH_INVALID, not a raw `git switch` failure (500).
    if (body.from) {
      const start = await this.raw(project, ['rev-parse', '--verify', '--quiet', `${body.from}^{commit}`]).catch(() => '');
      if (start.trim() === '') throw new ApiHttpError(400, 'BRANCH_INVALID', `No commit found at start point "${body.from}".`);
      await this.ensureDirty(project, `Creating a branch from ${body.from}`);
    }
    try {
      await git(['switch', '-c', body.name, ...(body.from ? [body.from] : [])], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git switch failed');
    }
    return this.status(projectId);
  }
}
