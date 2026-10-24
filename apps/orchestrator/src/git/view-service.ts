// apps/orchestrator/src/git/view-service.ts
import { type BranchListDTO, type CommitDTO, type CommitFilesDTO, type CommitLogDTO, type GitDiscardRequest, type GitCommitRequest, type GitStageRequest, type GitStatusDTO } from '@aik/contracts';
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
    return {
      projectId,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
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
    const real = fs.realpathSync.native(abs);
    if (!(real === fs.realpathSync.native(project.repoPath) || real.startsWith(fs.realpathSync.native(project.repoPath) + path.sep))) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Path escapes the repository: ${rel}`);
    }
    return real;
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
    for (const p of body.paths) {
      this.resolveInRepo(project, p);
      // Brief deviation: `GitStatusDTO` has no `files` — the brief's duplicated `st.files.find(...)`
      // was meant as the staged/unstaged pair (`staged` | `changes`), matching its Note 1.
      const entry = st.staged.find((f) => f.path === p) ?? st.changes.find((f) => f.path === p);
      if (entry && entry.x === '?' && entry.y === '?') untracked.push(p);
      else tracked.push(p);
    }
    if (untracked.length > 0) {
      for (const p of untracked) fs.rmSync(this.resolveInRepo(project, p), { force: true });
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
}
