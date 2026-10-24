# Delete Project (PM-1) and Git Working-Tree View (IDE-4X) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `DELETE /projects/:id` (sanctioned purge; never touches the user's folder) and a per-project VS Code-style Git tab (status, staged/unstaged staging, commit, discard, push, pull, branch dropdown, history).

**Architecture:** Backend = `GitViewService` in `apps/orchestrator/src/git/view-service.ts` wrapping the existing `git()` / `gitWithCredentials()` exec-file primitives, exposed via `GET/POST /projects/:id/git/*` routes through the existing `mutation()` idempotency middleware. Delete reuses the parent spec's §15.3 purge procedure (drop append-only triggers → ordered deletes in one immediate transaction → recreate triggers → audit line). Frontend = React tab `Board | Git` on the project page speaking to a small typed client lib with a 5 s status poll; dashboard card gains a `⋯` → two-step delete dialog.

**Tech Stack:** TypeScript ESM (`node:` imports with `.ts` suffixes), Fastify, Drizzle ORM + better-sqlite3 (`@aik/db`), zod v4 contracts (`@aik/contracts`), React 19 + TanStack Router + Tailwind tokens, Vitest, Playwright (Electron).

**Design spec:** `docs/superpowers/specs/2026-10-24-delete-project-and-git-view-design.md` — read it first. Mockup reference (user-approved): variant A, two columns (Source Control left, History right) + branch dropdown.

## Execution outcome

Executed **subagent-driven on `main`**, one subagent per task with review between tasks; every task ran the repo gate (lint, typecheck, touched tests) before its file-scoped commit.

- **Tasks 1–11: done and committed** (commit range `41e70ed..560f32d`). All review findings were resolved in-task. Factual corrections of this plan's own code blocks are folded in below as *Execution note* callouts (Tasks 1, 2, 4, 9, 11).
- **Task 12 (docs, repo-wide gates): done** — repo-wide gate green (`npm run check:pins && npm run lint && npm run typecheck && npm test`, 816 backend tests / 90 files); e2e 44/45 with the feature's git-tab specs 2/2 — the single failure is a pre-existing `board.spec.ts` flake (timeouts waiting for a freshly created card's "Move to…" button; a retried run passed that test and flaked a sibling with the same signature). README "Project lifecycle" added. The board flake and other minor notes are carried forward to the final whole-branch review.

## Global Constraints

- Node ≥ 24.17.0; Git for Windows ≥ 2.38. Windows-only platform.
- Dependencies: **exact versions only** (`npm install -E`); `npm run check:pins` must pass. This plan adds **zero** new packages.
- Tests must never operate on a real repository: use `apps/orchestrator/test/helpers/temp.ts` (`assertInTemp` hard-guards every path to the OS temp dir). Temp repos only via `makeTempRepo` / `makeTempRemoteAndClone`.
- Never log or persist secrets; persisted git/tools output goes through the redactor (`stripCredentials` for git stderr surfacing).
- Story status changes only through `WorkflowService`; this plan changes **no** story state directly (test setup may force rows with `forceStory`).
- Every mutating route must use `mutation()` (UUID `Idempotency-Key` header required).
- Legacy audit tables (`IMMUTABLE_TABLES` in `@aik/db`) are append-only by DB triggers; only the sanctioned purge (Task 9) may delete rows there, by dropping/recreating the delete triggers inside the transaction.
- The user's project folder on disk is **never** a mutation target (delete must not run git inside `repoPath`; worktree pruning only touches `<data>/wt`).
- Before claiming ANY task complete: `npm run lint && npm run typecheck && npx vitest run <touched test files>`; the repo-wide gate `npm run check:pins && npm run lint && npm run typecheck && npm test` runs in Task 12.
- Error envelope codes come from `ERROR_CODES` in `packages/contracts/src/common.ts`; only codes defined there may be thrown in `ApiHttpError`.

## File Structure (final state)

```
packages/contracts/src/common.ts                                  (modify: new error codes)
packages/contracts/src/git-view.ts                                (create: DTOs + request schemas)
packages/contracts/src/index.ts                                   (modify: export git-view)
apps/orchestrator/src/projects/busy.ts                            (create: agentBusy reason helper)
apps/orchestrator/src/git/status-parse.ts                         (create: pure porcelain parser)
apps/orchestrator/src/git/git.ts                                  (modify: stdin input support)
apps/orchestrator/src/git/view-service.ts                         (create: GitViewService)
apps/orchestrator/src/api/routes/git-view.ts                      (create: /projects/:id/git/* routes)
apps/orchestrator/src/api/routes/projects.ts                      (modify: DELETE /projects/:id)
apps/orchestrator/src/projects/service.ts                         (modify: delete() + purge deps)
apps/orchestrator/src/projects/purge-repo.ts                      (create: purgeProjectData tx)
apps/orchestrator/src/git/worktree.ts                             (modify: purgeForProject)
apps/orchestrator/src/app.ts                                      (modify: service + route wiring)
apps/ui/src/lib/git-view.ts                                       (create: client + polling hook)
apps/ui/src/components/git/scm-panel.tsx                          (create)
apps/ui/src/components/git/branch-dropdown.tsx                    (create)
apps/ui/src/components/git/history-column.tsx                     (create)
apps/ui/src/routes/git-page.tsx                                   (create)
apps/ui/src/routes/board.tsx                                      (modify: Board | Git tabs)
apps/ui/src/router.tsx                                            (modify: git child route)
apps/ui/src/routes/dashboard.tsx                                  (modify: card ⋯ + two-step dialog)
apps/orchestrator/test/status-parse.test.ts                       (create)
apps/orchestrator/test/busy.test.ts                               (create)
apps/orchestrator/test/view-service.test.ts                       (create)
apps/orchestrator/test/git-view-routes.test.ts                    (create)
apps/orchestrator/test/project-delete.test.ts                     (create)
apps/orchestrator/test/helpers/temp.ts                            (modify: appendFile helper + repomAke)
e2e/tests/git-tab.spec.ts                                          (create)
README.md                                                         (modify: feature notes)
```

Design-note: the spec's §4.4 FD-K alignment becomes unnecessary — the purge (Task 9) uses **explicit ordered deletes**, so **no DB migration is generated** in this plan. `npm run db:generate` must NOT be run.

---

### Task 1: Contracts — error codes + git-view DTOs

**Files:**
- Modify: `packages/contracts/src/common.ts` (ERROR_CODES list, lines 5–8)
- Create: `packages/contracts/src/git-view.ts`
- Modify: `packages/contracts/src/index.ts` (export line)

**Interfaces:**
- Produces (used by every later task): `GitFileDTO{x,y}`, `GitStatusDTO{projectId,branch,upstream,ahead,behind,staged,changes,mergeState,agentBusy,headSha}`, `CommitDTO{sha,short,author,dateIso,subject,parents}`, `CommitLogDTO`, `CommitFilesDTO`, `BranchListDTO`, `GitStageRequest`, `GitCommitRequest`, `GitDiscardRequest`, `GitBranchCheckoutRequest`, `GitBranchCreateRequest`, and error codes `PROJECT_BUSY`, `PROJECT_PURGE_FAILED`, `WORKING_TREE_DIRTY`, `DIVERGED`, `NO_REMOTE`, `IDENTITY_MISSING`, `NOT_IN_WORKING_TREE`, `MERGE_IN_PROGRESS`, `BRANCH_INVALID`.

- [ ] **Step 1: Add the error codes to `packages/contracts/src/common.ts`**

Replace the `ERROR_CODES` const:

```ts
export const ERROR_CODES = [
  'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN_ORIGIN', 'NOT_FOUND', 'VERSION_CONFLICT',
  'GUARD_FAILED', 'IDEMPOTENCY_MISMATCH', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL',
  'PROJECT_BUSY', 'PROJECT_PURGE_FAILED', 'WORKING_TREE_DIRTY', 'DIVERGED', 'NO_REMOTE',
  'IDENTITY_MISSING', 'NOT_IN_WORKING_TREE', 'MERGE_IN_PROGRESS', 'BRANCH_INVALID',
] as const;
```

- [ ] **Step 2: Create `packages/contracts/src/git-view.ts`**

```ts
// packages/contracts/src/git-view.ts
import { z } from 'zod';

/** One path from `git status --porcelain`: x = index state, y = worktree state (single chars). */
export const GitFileDTO = z.object({
  path: z.string().min(1).max(2000),
  x: z.string().length(1),
  y: z.string().length(1),
});
export type GitFileDTO = z.infer<typeof GitFileDTO>;

export const GitStatusDTO = z.object({
  projectId: z.number().int(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  staged: z.array(GitFileDTO),
  changes: z.array(GitFileDTO),
  /** merge/rebase markers: git mutations pause unless 'none'. */
  mergeState: z.enum(['none', 'merge', 'rebase']),
  agentBusy: z.boolean(),
  headSha: z.string().nullable(),
});
export type GitStatusDTO = z.infer<typeof GitStatusDTO>;

export const CommitDTO = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  short: z.string().min(1).max(12),
  author: z.string().max(200),
  dateIso: z.string(),
  subject: z.string().max(400),
  parents: z.array(z.string()),
});
export type CommitDTO = z.infer<typeof CommitDTO>;

export const CommitLogDTO = z.object({ projectId: z.number().int(), commits: z.array(CommitDTO) });
export type CommitLogDTO = z.infer<typeof CommitLogDTO>;

export const CommitFileDTO = z.object({ path: z.string().min(1).max(2000), change: z.enum(['A', 'M', 'D', 'R', 'T', 'C']) });
export type CommitFileDTO = z.infer<typeof CommitFileDTO>;

export const CommitFilesDTO = z.object({ projectId: z.number().int(), sha: CommitDTO.shape.sha, files: z.array(CommitFileDTO) });
export type CommitFilesDTO = z.infer<typeof CommitFilesDTO>;

export const BranchListDTO = z.object({ projectId: z.number().int(), current: z.string().nullable(), local: z.array(z.string()), remote: z.array(z.string()) });
export type BranchListDTO = z.infer<typeof BranchListDTO>;

const PathList = z.array(z.string().min(1).max(2000)).min(1).max(500);

export const GitStageRequest = z.union([
  z.strictObject({ paths: PathList }),
  z.strictObject({ all: z.literal(true) }),
]);
export type GitStageRequest = z.infer<typeof GitStageRequest>;

/** `paths` commits those files directly (stage-then-commit); otherwise commits what is staged. */
export const GitCommitRequest = z.object({ message: z.string().trim().min(1).max(4000), paths: PathList.optional() }).strict();
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

export const GitDiscardRequest = z.object({ paths: PathList }).strict();
export type GitDiscardRequest = z.infer<typeof GitDiscardRequest>;

export const GitBranchCheckoutRequest = z.object({ name: z.string().min(1).max(200) }).strict();
export type GitBranchCheckoutRequest = z.infer<typeof GitBranchCheckoutRequest>;

export const GitBranchCreateRequest = z.object({ name: z.string().min(1).max(200), from: z.string().max(200).optional() }).strict();
export type GitBranchCreateRequest = z.infer<typeof GitBranchCreateRequest>;
```

> Execution note: as landed, the `GitStageRequest` union members are `z.strictObject(...)` — zod 4.6.7 has no `z.union().strict()`. The hybrid stage-payload rejection test (`all` + `paths` → `400 VALIDATION_FAILED`) landed with Task 7 rather than here.

- [ ] **Step 3: Export it — add one line to `packages/contracts/src/index.ts`**

```ts
export * from './git-view.ts';
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: PASS (no output, exit 0)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/common.ts packages/contracts/src/git-view.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): git view DTOs and delete/git-view error codes"
```

---

### Task 2: Project busy-guard helper

**Files:**
- Create: `apps/orchestrator/src/projects/busy.ts`
- Test: `apps/orchestrator/test/busy.test.ts`

**Interfaces:**
- Consumes: `AikDb` from `@aik/db` (typed Drizzle wrapper over better-sqlite3).
- Produces: `projectBusyReason(db: AikDb, projectId: number): string | null` — a human reason while an agent run, verification, or merge is running for the project; `null` when free. Used by GitViewService (Task 5/6) and ProjectService.delete (Task 9).

- [ ] **Step 1: Write the failing test `apps/orchestrator/test/busy.test.ts`**

```ts
// apps/orchestrator/test/busy.test.ts
import { agentRuns, merges, verificationRuns } from '@aik/db';
import { describe, expect, it } from 'vitest';
import { projectBusyReason } from '../src/projects/busy.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

const NOW = new Date(1_700_000_000_000);

describe('projectBusyReason', () => {
  it('is null on a silent project', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    expect(projectBusyReason(t.db, p.id)).toBeNull();
  });

  it('names the story with a running agent run', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id, { key: 'P1A-4' });
    t.db.insert(agentRuns).values({
      storyId: s.id, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0',
      idempotencyKey: 'k-run-1', status: 'running', startedAt: NOW,
    }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('P1A-4');
  });

  it('sees queued runs, running verifications and merges', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: 'a'.repeat(40), trigger: 'candidate', status: 'running', startedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('verification');
    t.db.insert(agentRuns).values({ storyId: s.id, role: 'reviewer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0', idempotencyKey: 'k-run-2', status: 'queued' }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('queued');
    t.db.insert(merges).values({ storyId: s.id, method: 'local_merge', approvedSha: 'a'.repeat(40), status: 'running', startedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('merging');
  });

  it('ignores finished work', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(agentRuns).values({ storyId: s.id, role: 'planner', attempt: 1, promptVersion: 'v1', opencodeVersion: '0', idempotencyKey: 'k-run-3', status: 'succeeded', startedAt: NOW, endedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/busy.test.ts`
Expected: FAIL — `Cannot find module '../src/projects/busy.ts'`

- [ ] **Step 3: Implement `apps/orchestrator/src/projects/busy.ts`**

```ts
// apps/orchestrator/src/projects/busy.ts
import type { AikDb } from '@aik/db';

/** True while a queued/running agent run, a running verification or a running merge belongs to the project. */
export function projectBusyReason(db: AikDb, projectId: number): string | null {
  const merge = db.$client
    .prepare(`SELECT u.key FROM user_stories u JOIN merges m ON m.story_id = u.id WHERE u.project_id = ? AND m.status = 'running' LIMIT 1`)
    .get(projectId) as { key: string } | undefined;
  if (merge) return `Story ${merge.key} is merging right now — Git actions and delete pause until it finishes`;
  const run = db.$client
    .prepare(`SELECT u.key, r.status FROM user_stories u JOIN agent_runs r ON r.story_id = u.id WHERE u.project_id = ? AND r.status IN ('queued', 'running') LIMIT 1`)
    .get(projectId) as { key: string; status: string } | undefined;
  if (run) return `Story ${run.key} has a ${run.status} agent run in progress — Git actions and delete pause until it finishes`;
  const verify = db.$client
    .prepare(`SELECT u.key FROM user_stories u JOIN verification_runs v ON v.story_id = u.id WHERE u.project_id = ? AND v.status = 'running' LIMIT 1`)
    .get(projectId) as { key: string } | undefined;
  if (verify) return `Story ${verify.key} is in verification — Git actions and delete pause until it finishes`;
  return null;
}
```

> Execution note: the landed busy reason interpolates the run's `status` (`Story ${key} has a ${status} agent run in progress`) and the check order is **merge → agent run → verification**; the original block's wording/order contradicted the Task 2 tests above.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/busy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/projects/busy.ts apps/orchestrator/test/busy.test.ts
git commit -m "feat(orchestrator): shared project busy-guard (PM-1/IDE-4X)"
```

---

### Task 3: Pure porcelain status parser

**Files:**
- Create: `apps/orchestrator/src/git/status-parse.ts`
- Test: `apps/orchestrator/test/status-parse.test.ts`

**Interfaces:**
- Produces: `parsePorcelainStatus(out: string): ParsedStatus` where `ParsedStatus = { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; files: { path: string; x: string; y: string }[] }` — used by `GitViewService` (Task 4).

- [ ] **Step 1: Write the failing test `apps/orchestrator/test/status-parse.test.ts`**

```ts
// apps/orchestrator/test/status-parse.test.ts
import { describe, expect, it } from 'vitest';
import { parsePorcelainStatus } from '../src/git/status-parse.ts';

describe('parsePorcelainStatus (z-terminated porcelain v1 + --branch)', () => {
  it('parses branch header with upstream and ahead/behind', () => {
    const out = '## main...origin/main [ahead 2, behind 1]\0';
    const s = parsePorcelainStatus(out);
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, files: [] });
  });

  it('parses a branch without upstream; nulls ahead/behind', () => {
    const s = parsePorcelainStatus('## local-only\0');
    expect(s).toMatchObject({ branch: 'local-only', upstream: null, ahead: null, behind: null });
  });

  it('parses staged, unstaged, untracked, deleted and conflict entries', () => {
    const out = '## main\0A  new-file.ts\0 M dirty.ts\0?? stray.bin\0D  gone.ts\0UU both-want.md\0';
    const s = parsePorcelainStatus(out);
    expect(s.files).toEqual([
      { path: 'new-file.ts', x: 'A', y: ' ' },
      { path: 'dirty.ts', x: ' ', y: 'M' },
      { path: 'stray.bin', x: '?', y: '?' },
      { path: 'gone.ts', x: 'D', y: ' ' },
      { path: 'both-want.md', x: 'U', y: 'U' },
    ]);
  });

  it('consumes the rename original-path field and keeps the new path', () => {
    const out = '## main\0R  new-name.ts\0old-name.ts\0';
    const s = parsePorcelainStatus(out);
    expect(s.files).toEqual([{ path: 'new-name.ts', x: 'R', y: ' ' }]);
  });

  it('returns null branch on a detached HEAD', () => {
    const s = parsePorcelainStatus('## HEAD (no branch)\0');
    expect(s.branch).toBeNull();
    expect(s.upstream).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/status-parse.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `apps/orchestrator/src/git/status-parse.ts`**

```ts
// apps/orchestrator/src/git/status-parse.ts
/** Parsed `git status --porcelain=v1 -z --branch`. */
export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: { path: string; x: string; y: string }[];
}

const AHEAD = /ahead (\d+)/;
const BEHIND = /behind (\d+)/;

export function parsePorcelainStatus(out: string): ParsedStatus {
  const fields = out.split('\0').filter((f) => f !== '');
  const s: ParsedStatus = { branch: null, upstream: null, ahead: null, behind: null, files: [] };
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.startsWith('## ')) {
      const rest = f.slice(3);
      const bracket = rest.indexOf('[');
      const header = bracket === -1 ? rest : rest.slice(0, bracket).trim();
      const m = AHEAD.exec(rest);
      s.ahead = m ? Number(m[1]) : null;
      const b = BEHIND.exec(rest);
      s.behind = b ? Number(b[1]) : null;
      const dd = header.indexOf('...');
      if (header === 'HEAD (no branch)') {
        s.branch = null;
        s.upstream = null;
      } else if (dd !== -1) {
        s.branch = header.slice(0, dd);
        s.upstream = header.slice(dd + 3);
      } else {
        s.branch = header;
        s.upstream = null;
      }
      continue;
    }
    const x = f[0] ?? ' ';
    const y = f[1] ?? ' ';
    if (x === 'R' || y === 'R' || x === 'C') i++; // next field holds the original path; keep the NEW path
    const p = f.slice(3);
    if (p !== '') s.files.push({ path: p, x, y });
  }
  return s;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/status-parse.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/git/status-parse.ts apps/orchestrator/test/status-parse.test.ts
git commit -m "feat(orchestrator): pure porcelain-v1 status parser for the Git view"
```

---

### Task 4: GitViewService — read commands (status, log, commit files, branches)

**Files:**
- Create: `apps/orchestrator/src/git/view-service.ts`
- Test: `apps/orchestrator/test/view-service.test.ts`

**Interfaces:**
- Consumes: `git()` from `./git/git.ts` (signature below), `parsePorcelainStatus` (Task 3), `projectBusyReason` (Task 2), DTOs (Task 1), `ProjectService.get()` (`ProjectDTO`), `GitError`.
- Produces: class `GitViewService` with constructor `new GitViewService(deps: { db: AikDb; now: Clock; projects: ProjectService; busy?: (projectId: number) => string | null; accessToken?: () => Promise<string | null> })` and **read** methods `status(projectId)`, `log(projectId, limit?)`, `commitFiles(projectId, sha)`, `branches(projectId)`. Mutations follow in Task 5/6. Throws `ApiHttpError`: `404 NOT_FOUND` unknown project / `409 NOT_IN_WORKING_TREE` dead folder; log `limit` clamped 1..200; unknown sha → `404 NOT_FOUND (type NOT_FOUND)`.

- [ ] **Step 1: Write the failing test `apps/orchestrator/test/view-service.test.ts` (read part)**

```ts
// apps/orchestrator/test/view-service.test.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitViewService } from '../src/git/view-service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempRemoteAndClone, makeTempRepo } from './helpers/temp.ts';
import { ProjectService } from '../src/projects/service.ts';
import { systemClock } from '../src/time.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tracked = (d: string) => {
  tempDirs.push(d);
  return d;
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', ...args], { cwd, encoding: 'utf8' });

async function setup(opts: { repo?: string } = {}) {
  const t = createTestDb();
  const repo = tracked(opts.repo ?? makeTempRepo({ name: 'wmk' }));
  const projects = new ProjectService({ db: t.db, now: systemClock });
  const svc = new GitViewService({ db: t.db, now: systemClock, projects });
  const project = await projects.create({ name: 'We Made Kits', key: 'WMK', repoPath: repo });
  return { t, repo, svc, project };
}

describe('GitViewService.status', () => {
  it('reports a clean tree', async () => {
    const { svc, project } = await setup();
    const s = await svc.status(project.id);
    expect(s).toMatchObject({ projectId: project.id, branch: 'main', upstream: null, ahead: null, behind: null, staged: [], changes: [], mergeState: 'none', agentBusy: false });
    expect((s.headSha ?? '').length).toBe(40);
  });

  it('splits staged and unstaged lists and detects untracked files', async () => {
    const { repo, svc, project } = await setup();
    // Untracked files report `?? dirty.ts`, so the x=' '/y='M' expectation below needs the file
    // tracked first, then modified; untracked detection stays covered by the stray file.
    fs.writeFileSync(path.join(repo, 'dirty.ts'), 'y');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'tmp');
    fs.writeFileSync(path.join(repo, 'staged.ts'), 'x');
    gitIn(repo, 'add', 'staged.ts');
    fs.writeFileSync(path.join(repo, 'dirty.ts'), 'y2');
    fs.writeFileSync(path.join(repo, 'stray.bin'), 'z');
    const s = await svc.status(project.id);
    expect(s.staged.map((f) => f.path)).toEqual(['staged.ts']);
    expect(s.changes.map((f) => f.path).sort()).toEqual(['dirty.ts', 'stray.bin']);
    const dirty = s.changes.find((f) => f.path === 'dirty.ts')!;
    expect(dirty.x).toBe(' ');
    expect(dirty.y).toBe('M');
  });
});

describe('GitViewService.log + commitFiles', () => {
  it('lists recent commits newest first and expands a commit\'s files', async () => {
    const { repo, svc, project } = await setup();
    fs.writeFileSync(path.join(repo, 'two.txt'), '1');
    gitIn(repo, 'add', 'two.txt');
    gitIn(repo, 'commit', '-q', '-m', 'feat: second');
    const log = await svc.log(project.id);
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]!.subject).toBe('feat: second');
    const files = await svc.commitFiles(project.id, log.commits[0]!.sha);
    expect(files.files).toEqual([{ path: 'two.txt', change: 'A' }]);
  });
});

describe('GitViewService.branches', () => {
  it('lists local + remote branches and the current one', async () => {
    const { clone: repo } = makeTempRemoteAndClone(tracked); // the clone's default branch is `trunk`
    const { svc, project } = await setup({ repo: tracked(repo) });
    gitIn(repo, 'switch', '-qc', 'feature/wing');
    gitIn(repo, 'switch', 'trunk');
    const b = await svc.branches(project.id);
    expect(b.current).toBe('trunk');
    expect(b.local).toContain('feature/wing');
    expect(b.remote.some((r) => r.startsWith('origin/'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: FAIL — `Cannot find module '../src/git/view-service.ts'`

- [ ] **Step 3: Implement `apps/orchestrator/src/git/view-service.ts` (read commands)**

```ts
// apps/orchestrator/src/git/view-service.ts
import {
  type BranchListDTO, type CommitDTO, type CommitFilesDTO, type CommitLogDTO, type GitDiscardRequest,
  type GitBranchCheckoutRequest, type GitBranchCreateRequest, type GitCommitRequest, type GitStageRequest, type GitStatusDTO,
} from '@aik/contracts';
import { agentRuns, type AikDb } from '@aik/db';
import { inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import type { ProjectService } from '../projects/service.ts';
import { systemClock, type Clock } from '../time.ts';
import { git, GitError, gitWithCredentials, stripCredentials } from './git.ts';
import { parsePorcelainStatus } from './status-parse.ts';

type Project = ReturnType<ProjectService['get']>;

export type GitMutationResult = GitStatusDTO;
const notFound = (message: string) => new ApiHttpError(404, 'NOT_FOUND', message);
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

  private headSha(project: Project): string | null {
    try {
      return git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: project.repoPath }) || null;
    } catch {
      return null;
    }
  }

  async status(projectId: number): Promise<GitStatusDTO> {
    const project = this.project(projectId);
    const out = await this.raw(project, ['status', '--porcelain=v1', '-z', '--branch']);
    const parsed = parsePorcelainStatus(out);
    const staged = parsed.files.filter((f) => f.x !== ' ' && f.x !== '?');
    const changes = parsed.files.filter((f) => f.y !== ' ' && f.y !== '?');
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
      headSha: this.headSha(project),
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
    const out = await this.raw(project, ['diff-tree', '--no-commit-id', '--name-status', '-r', sha]).catch(() => '');
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
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: PASS — the 4 tests shown above, plus the tests added during execution fixes (root-commit file expansion, unknown-sha 404, and the Task 5/6 mutation suites appended to the same file).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/git/view-service.ts apps/orchestrator/test/view-service.test.ts
git commit -m "feat(orchestrator): GitViewService reads — status, log, commit files, branches"
```

---

### Task 5: GitViewService — stage, unstage, commit, discard (+ stdin-capable `git()`)

**Files:**
- Modify: `apps/orchestrator/src/git/git.ts` (add `input?: string` option)
- Modify: `apps/orchestrator/src/git/view-service.ts` (add mutating methods + guards)
- Test: `apps/orchestrator/test/view-service.test.ts` (append mutation describe blocks)

**Interfaces:**
- Produces (used by routes in Task 7 and UI in Task 8): `stage(id, body: GitStageRequest)`, `unstage(id, body: GitStageRequest)`, `commit(id, body: GitCommitRequest)`, `discard(id, body: GitDiscardRequest)` — each returns a fresh `GitStatusDTO`. Guards thrown as `ApiHttpError`: `409 PROJECT_BUSY` (via `busy`), `409 MERGE_IN_PROGRESS` (`mergeState !== 'none'`), `400 IDENTITY_MISSING` (no `user.name`/`user.email`), and `400 VALIDATION_FAILED "Nothing staged to commit"` for an empty staged set (the panel disables Commit in that case; `WORKING_TREE_DIRTY` is reserved for pull/branch-switch refusals). `discard` on tracked paths = `git restore -- <paths>`; on untracked (`??`) paths = delete the file (after realpath containment).

- [ ] **Step 1: Make `git()` stdin-capable — modify `apps/orchestrator/src/git/git.ts`**

Change the signature line to:

```ts
export function git(args: string[], opts: { cwd: string; timeoutMs?: number; input?: string }): Promise<string> {
```

and replace `child.stdin?.end();` (the last statement of the promise executor) with:

```ts
    if (opts.input) child.stdin?.write(opts.input);
    child.stdin?.end();
```

- [ ] **Step 2: Append the failing tests to `apps/orchestrator/test/view-service.test.ts`**

Append the following blocks after the existing `describe` sections.

```ts
describe('GitViewService stage/unstage/commit/discard', () => {
  it('stages by path and by all, unstages back', async () => {
    const { repo, svc, project } = setup();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b');
    let s = await svc.stage(project.id, { paths: ['a.ts'] });
    expect(s.staged.map((f) => f.path)).toEqual(['a.ts']);
    s = await svc.stage(project.id, { all: true });
    expect(s.staged.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    s = await svc.unstage(project.id, { paths: ['a.ts'] });
    expect(s.staged.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('rejects committing with nothing staged (VALIDATION_FAILED)', async () => {
    const { svc, project } = setup();
    await expect(svc.commit(project.id, { message: 'nothing yet' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await svc.status(project.id)).staged).toEqual([]);
  });

  it('commits staged work and clears the lists', async () => {
    const { repo, svc, project } = setup();
    fs.writeFileSync(path.join(repo, 'one.ts'), '1');
    await svc.stage(project.id, { all: true });
    const s = await svc.commit(project.id, { message: 'first work' });
    expect(s.staged).toEqual([]);
    const log = await svc.log(project.id);
    expect(log.commits[0]!.subject).toBe('first work');
  });

  it('commits given paths directly (stage-then-commit)', async () => {
    const { repo, svc, project } = setup();
    fs.writeFileSync(path.join(repo, 'direct.ts'), 'd');
    fs.writeFileSync(path.join(repo, 'left.ts'), 'l');
    const s = await svc.commit(project.id, { message: 'only direct', paths: ['direct.ts'] });
    expect(s.changes.map((f) => f.path)).toEqual(['left.ts']);
    expect(s.staged).toEqual([]);
    const log = await svc.log(project.id);
    expect(log.commits[0]!.subject).toBe('only direct');
  });

  it('fails with IDENTITY_MISSING when the repo has no user config', async () => {
    const { repo, svc, project } = setup();
    fs.writeFileSync(path.join(repo, 'x.ts'), 'x');
    gitIn(repo, 'config', '--unset', 'user.name');
    gitIn(repo, 'config', '--unset', 'user.email');
    await svc.stage(project.id, { all: true });
    await expect(svc.commit(project.id, { message: 'anon' })).rejects.toMatchObject({ code: 'IDENTITY_MISSING' });
  });

  it('discards tracked (restore) and deletes untracked — after containment check', async () => {
    const { repo, svc, project } = setup();
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'v1');
    await svc.discard(project.id, { paths: ['untracked.txt'] });
    expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(false);
    await svc.discard(project.id, { paths: ['tracked.txt'] });
    expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('# test\n');
  });

  it('refuses mutations while merge state is active', async () => {
    const { repo, svc, project } = setup();
    // force MERGE_HEAD-like condition without a real merge: git merge with divergent branches
    gitIn(repo, 'switch', '-qc', 'side');
    fs.writeFileSync(path.join(repo, 'side.txt'), 's');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'side');
    gitIn(repo, 'switch', 'main');
    fs.writeFileSync(path.join(repo, 'main.txt'), 'm');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'main');
    gitIn(repo, 'merge', '--no-commit', 'side');
    await expect(svc.stage(project.id, { all: true })).rejects.toMatchObject({ code: 'MERGE_IN_PROGRESS' });
    await expect(svc.commit(project.id, { message: 'nope' })).rejects.toMatchObject({ code: 'MERGE_IN_PROGRESS' });
    expect(await svc.status(project.id)).toMatchObject({ mergeState: 'merge' });
    gitIn(repo, 'merge', '--abort');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: FAIL — `svc.stage is not a function`

- [ ] **Step 4: Implement the mutations — append to the `GitViewService` class in `apps/orchestrator/src/git/view-service.ts`**

```ts
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

  private async add(project: Project, paths: string[]): Promise<void> {
    try {
      await git(['add', '--', ...paths], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git add failed');
    }
  }

  async stage(projectId: number, body: GitStageRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    const paths = body.all ? ['.', '-A'] : body.paths;
    await this.add(project, paths);
    return this.status(projectId);
  }

  async unstage(projectId: number, body: GitStageRequest): Promise<GitMutationResult> {
    const project = await this.assertMutable(projectId);
    try {
      if (body.all) await git(['reset', '-q', 'HEAD'], { cwd: project.repoPath });
      else await git(['reset', '-q', 'HEAD', '--', ...body.paths], { cwd: project.repoPath });
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
      const entry = st.files.find((f) => f.path === p) ?? st.files.find((f) => f.path === p);
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
```

> Note 1: `discard` lookup of `st.files.find(...)` compares `path` for both staged/unstaged spellings; if not found, treat as tracked restore (harmless).
> Note 2: an empty staged commit throws `400 VALIDATION_FAILED "Nothing staged to commit"` — NOT `WORKING_TREE_DIRTY`, which stays reserved for pull/branch-switch refusals.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: PASS (12 tests: 5 reads + 7 mutation blocks' `it`s)

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/git/git.ts apps/orchestrator/src/git/view-service.ts apps/orchestrator/test/view-service.test.ts
git commit -m "feat(orchestrator): git view mutations — stage/unstage/commit/discard with guards"
```

---

### Task 6: GitViewService — push/pull and branch checkout/create

**Files:**
- Modify: `apps/orchestrator/src/git/view-service.ts` (append 4 methods + dirty-pull/checkout helper)
- Test: `apps/orchestrator/test/view-service.test.ts` (append)

**Interfaces:**
- Produces: `push(id)`, `pull(id)`, `checkout(id, body: GitBranchCheckoutRequest)`, `createBranch(id, body: GitBranchCreateRequest)` — each returns a fresh `GitStatusDTO`. Errors: `409 NO_REMOTE` (no `origin`, or no upstream on pull), `409 DIVERGED` (pull can't fast-forward), `409 WORKING_TREE_DIRTY` (pull/checkout with uncommitted changes), `400 BRANCH_INVALID` (invalid name, unknown branch, remote-only branch, or existing name on create).

- [ ] **Step 1: Append the failing tests to `apps/orchestrator/test/view-service.test.ts`**

```ts
describe('GitViewService push/pull', () => {
  it('pushes to a local bare remote, sets upstream; pull fast-forwards', async () => {
    const { remote, clone } = makeTempRemoteAndClone(); // the clone's default branch is `trunk`
    const { svc, project } = setup({ repo: tracked(clone) });
    fs.writeFileSync(path.join(clone, 'wing.txt'), 'w');
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-qm', 'wing');
    const pushed = await svc.push(project.id);
    expect(pushed.ahead).toBe(0);
    expect(pushed.upstream).toBe('origin/trunk');
    // simulate a second user pushing, then pull
    const seeded = makeTempRepo({ name: 'second-clone' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seeded });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: seeded });
    execFileSync('git', ['reset', '-q', '--hard', 'origin/trunk'], { cwd: seeded });
    fs.writeFileSync(path.join(seeded, 'second.txt'), 's2');
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'add', '.'], { cwd: seeded });
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'commit', '-qm', 'from second'], { cwd: seeded });
    execFileSync('git', ['push', '-q', 'origin', 'trunk'], { cwd: seeded });
    const pulled = await svc.pull(project.id);
    expect(fs.existsSync(path.join(clone, 'second.txt'))).toBe(true);
    expect(pulled.behind).toBe(0);
  });

  it('refuses pull with local changes (WORKING_TREE_DIRTY) and divergent history (DIVERGED)', async () => {
    const { remote, clone } = makeTempRemoteAndClone();
    const { repo, svc, project } = setup({ repo: tracked(clone) });
    fs.writeFileSync(path.join(repo, 'local-change.txt'), 'x');
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'WORKING_TREE_DIRTY' });
    fs.rmSync(path.join(repo, 'local-change.txt'));
    const seeded = makeTempRepo({ name: 'diverge' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seeded });
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: seeded });
    execFileSync('git', ['reset', '-q', '--hard', 'origin/trunk'], { cwd: seeded });
    fs.writeFileSync(path.join(seeded, 'diverge.txt'), 'd');
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'add', '.'], { cwd: seeded });
    execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', 'commit', '-qm', 'diverge'], { cwd: seeded });
    fs.writeFileSync(path.join(repo, 'own.txt'), 'o');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'own');
    execFileSync('git', ['push', '-q', 'origin', 'trunk'], { cwd: seeded });
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'DIVERGED' });
  });

  it('refuses when there is no origin remote', async () => {
    const { svc, project } = setup();
    await expect(svc.push(project.id)).rejects.toMatchObject({ code: 'NO_REMOTE' });
    await expect(svc.pull(project.id)).rejects.toMatchObject({ code: 'NO_REMOTE' });
  });
});

describe('GitViewService branches: checkout/create', () => {
  it('creates and switches, refuses duplicates, respects check-ref-format', async () => {
    const { svc, project } = setup();
    const created = await svc.createBranch(project.id, { name: 'story/feature' });
    expect(created.branch).toBe('story/feature');
    await expect(svc.createBranch(project.id, { name: 'story/feature' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
    await expect(svc.createBranch(project.id, { name: 'bad name..' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
    const back = await svc.checkout(project.id, { name: 'main' });
    expect(back.branch).toBe('main');
    await expect(svc.checkout(project.id, { name: 'origin/main' })).rejects.toMatchObject({ code: 'BRANCH_INVALID' });
  });

  it('refuses checkout with uncommitted changes', async () => {
    const { repo, svc, project } = setup();
    gitIn(repo, 'switch', '-qc', 'elsewhere');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'd');
    await expect(svc.checkout(project.id, { name: 'elsewhere' })).rejects.toMatchObject({ code: 'WORKING_TREE_DIRTY' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: FAIL — `svc.push is not a function`

- [ ] **Step 3: Implement — append to `GitViewService`**

```ts
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
      if (err instanceof GitError && /not possible to fast-forward/i.test(err.stderr ?? '')) {
        throw new ApiHttpError(409, 'DIVERGED', 'Pull would need a merge — resolve by rebasing/merging in your terminal, then push or pull again.');
      }
      throw gitErrorToApi(err, 'git pull failed');
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
    if (body.from) await this.ensureDirty(project, `Creating a branch from ${body.from}`);
    try {
      await git(['switch', '-c', body.name, ...(body.from ? [body.from] : [])], { cwd: project.repoPath });
    } catch (err) {
      throw gitErrorToApi(err, 'git switch failed');
    }
    return this.status(projectId);
  }
```

> Note: branching from the current HEAD never touches the working tree, so the dirty check only applies when `from` points elsewhere.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/view-service.test.ts`
Expected: PASS (17 tests: previous 12 + 5 new)

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/git/view-service.ts apps/orchestrator/test/view-service.test.ts
git commit -m "feat(orchestrator): git push/pull (--ff-only) and branch checkout/create"
```

---

### Task 7: Git-view HTTP routes + orchestrator wiring + test-app extension

**Files:**
- Create: `apps/orchestrator/src/api/routes/git-view.ts`
- Modify: `apps/orchestrator/src/app.ts` (construct `GitViewService`, register routes)
- Modify: `apps/orchestrator/test/helpers/app.ts` (register git routes in `buildTestApp`, accept `'DELETE'` in inject)
- Test: `apps/orchestrator/test/git-view-routes.test.ts` (create)

**Interfaces:**
- Consumes: `GitViewService` (Tasks 4–6), `mutation()/parse()` (`../idempotency.ts`), `IdParams` from `./projects.ts`.
- Produces: `registerGitViewRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; gitView: GitViewService })` with routes `GET /projects/:id/git/status`, `GET /projects/:id/git/log?limit=`, `GET /projects/:id/git/commits/:sha/files`, `GET /projects/:id/git/branches`, `POST /projects/:id/git/{stage,unstage,commit,discard,push,pull,branches/checkout,branches/create}`. Every POST is `mutation()`-wrapped (UUID `Idempotency-Key` required by the renderer's `api.post` automatically).

- [ ] **Step 1: Write the failing test `apps/orchestrator/test/git-view-routes.test.ts`**

```ts
// apps/orchestrator/test/git-view-routes.test.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';
import { makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('git view routes', () => {
  it('GET status works and stage/commit mutate with idempotency keys', async () => {
    const { app, inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'routes' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'We Made Kits', key: 'WMK', repoPath: repo });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as number;
    const status = await inject('GET', `/projects/${id}/git/status`);
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ branch: 'main', agentBusy: false });
    fs.writeFileSync(path.join(repo, 'notes.md'), 'n');
    const stage = await inject('POST', `/projects/${id}/git/stage`, { all: true });
    expect(stage.statusCode).toBe(200);
    expect(JSON.parse(stage.body).staged).toHaveLength(1);
    const firstKey = crypto.randomUUID();
    const first = await inject('POST', `/projects/${id}/git/commit`, { message: 'route commit' }, firstKey);
    expect(first.statusCode).toBe(200);
    // same key + same body-hash replays the stored response instead of committing again
    fs.writeFileSync(path.join(repo, 'more.md'), 'm');
    await inject('POST', `/projects/${id}/git/stage`, { all: true });
    const replay = await inject('POST', `/projects/${id}/git/commit`, { message: 'route commit' }, firstKey);
    expect(replay.statusCode).toBe(200);
    const log = await inject('GET', `/projects/${id}/git/log?limit=5`);
    const commits = JSON.parse(log.body).commits.map((c: { subject: string }) => c.subject);
    expect(commits.filter((c) => c === 'route commit')).toHaveLength(1);
  });

  it('refuses mutations while the project is busy; reads still work', async () => {
    const { inject } = await buildTestApp({ fakeBusy: () => 'Story B-1 has an agent run' });
    const repo = makeTempRepo({ name: 'busy-routes' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'B', key: 'PB', repoPath: repo });
    const id = JSON.parse(created.body).id as number;
    const status = await inject('GET', `/projects/${id}/git/status`);
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body).agentBusy).toBe(true);
    const stage = await inject('POST', `/projects/${id}/git/stage`, { all: true });
    expect(stage.statusCode).toBe(409);
    expect(stage.json().error.code).toBe('PROJECT_BUSY');
  });
});
```

> Note: `buildTestApp` gains an options param `{ fakeBusy?: (projectId: number) => string | null }` (wired in Step 5); reads stay available while mutations return `409 PROJECT_BUSY`. The delete-level busy case is covered in Task 9.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/git-view-routes.test.ts`
Expected: FAIL — `buildTestApp` has no git routes → `inject('GET', '/projects/1/git/status')` → 404 route not found

- [ ] **Step 3: Implement `apps/orchestrator/src/api/routes/git-view.ts`**

```ts
// apps/orchestrator/src/api/routes/git-view.ts
import {
  GitBranchCheckoutRequest, GitBranchCreateRequest, GitCommitRequest, GitDiscardRequest, GitStageRequest,
} from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { GitViewService } from '../../git/view-service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';
import { z } from 'zod';

export function registerGitViewRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; gitView: GitViewService }): void {
  const idOf = (req: { params: unknown }) => parse(IdParams, req.params).id;
  const ShaParams = z.object({ id: z.coerce.number().int().positive(), sha: z.string().regex(/^[0-9a-f]{40}$/) });

  app.get('/projects/:id/git/status', async (req) => deps.gitView.status(idOf(req)));
  app.get('/projects/:id/git/log', async (req) => {
    const q = req.query as { limit?: string };
    return deps.gitView.log(idOf(req), q.limit ? Number(q.limit) : 50);
  });
  app.get('/projects/:id/git/commits/:sha/files', async (req) => {
    const p = parse(ShaParams, req.params);
    return deps.gitView.commitFiles(p.id, p.sha);
  });
  app.get('/projects/:id/git/branches', async (req) => deps.gitView.branches(idOf(req)));

  mutation(app, deps, 'POST', '/projects/:id/git/stage', async (req) => ({ status: 200, body: await deps.gitView.stage(idOf(req), parse(GitStageRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/unstage', async (req) => ({ status: 200, body: await deps.gitView.unstage(idOf(req), parse(GitStageRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/commit', async (req) => ({ status: 200, body: await deps.gitView.commit(idOf(req), parse(GitCommitRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/discard', async (req) => ({ status: 200, body: await deps.gitView.discard(idOf(req), parse(GitDiscardRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/push', async (req) => ({ status: 200, body: await deps.gitView.push(idOf(req)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/pull', async (req) => ({ status: 200, body: await deps.gitView.pull(idOf(req)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/branches/checkout', async (req) => ({ status: 200, body: await deps.gitView.checkout(idOf(req), parse(GitBranchCheckoutRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/branches/create', async (req) => ({ status: 200, body: await deps.gitView.createBranch(idOf(req), parse(GitBranchCreateRequest, req.body)) }));
}
```

- [ ] **Step 4: Wire it up — modify `apps/orchestrator/src/app.ts`**

After `const projects = new ProjectService({ db });` (around line 112), the services construction stays; add AFTER the `github` service block (near line 170, after `new GitHubAuthService` group):

```ts
import { registerGitViewRoutes } from './api/routes/git-view.ts';
import { GitViewService } from './git/view-service.ts';
import { projectBusyReason } from './projects/busy.ts';
// ...
  const gitView = new GitViewService({
    db,
    projects,
    busy: (projectId) => projectBusyReason(db, projectId),
    accessToken: async () => {
      try {
        const auth = await github.getValidAccessToken();
        return auth?.token ?? null;
      } catch {
        return null;
      }
    },
  });
```

and next to `registerProjectRoutes(...)`:

```ts
  registerGitViewRoutes(app, { db, now: systemClock, gitView });
```

- [ ] **Step 5: Extend `apps/orchestrator/test/helpers/app.ts`**

Replace the whole file with:

```ts
// apps/orchestrator/test/helpers/app.ts
import crypto from 'node:crypto';
import { createApiServer } from '../../src/api/server.ts';
import { registerGitViewRoutes } from '../../src/api/routes/git-view.ts';
import { registerProjectRoutes } from '../../src/api/routes/projects.ts';
import { registerStoryRoutes } from '../../src/api/routes/stories.ts';
import { GitViewService } from '../../src/git/view-service.ts';
import { EventBus } from '../../src/events/bus.ts';
import { projectBusyReason } from '../../src/projects/busy.ts';
import { ProjectService } from '../../src/projects/service.ts';
import { createRedactor } from '../../src/secrets/redactor.ts';
import { StoryService } from '../../src/stories/service.ts';
import { WorkflowService } from '../../src/workflow/service.ts';
import { createTestDb } from './db.ts';

import type { LocalMerger } from '../../src/git/merger.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41236;

export async function buildTestApp(options?: { merger?: LocalMerger; fakeBusy?: (projectId: number) => string | null }) {
  const t = createTestDb();
  const now = () => 1_700_000_000_000;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db: t.db, bus, now, redact: createRedactor().redact });
  const projects = new ProjectService({ db: t.db, now });
  const stories = new StoryService({ db: t.db, workflow, bus, now, merger: options?.merger });
  const busy = options?.fakeBusy ?? ((projectId: number) => projectBusyReason(t.db, projectId));
  const gitView = new GitViewService({ db: t.db, projects, busy });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now, projects });
  registerGitViewRoutes(app, { db: t.db, now, gitView });
  registerStoryRoutes(app, { db: t.db, now, stories });
  await app.ready();
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key: string = crypto.randomUUID()) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    });
  return { t, app, inject, bus, services: { workflow, projects, stories, gitView } };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run apps/orchestrator/test/git-view-routes.test.ts apps/orchestrator/test/projects.test.ts apps/orchestrator/test/stories.test.ts`
Expected: PASS (routes test + NO regressions in existing route tests). If `stories.test.ts` does not exist in this repo, run only the two files that do.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/api/routes/git-view.ts apps/orchestrator/src/app.ts apps/orchestrator/test/helpers/app.ts apps/orchestrator/test/git-view-routes.test.ts
git commit -m "feat(orchestrator): git view HTTP routes and app wiring"
```

---

### Task 8: Renderer — Git tab (lib, panels, page, router)

**Files:**
- Create: `apps/ui/src/lib/git-view.ts`
- Create: `apps/ui/src/components/git/scm-panel.tsx`
- Create: `apps/ui/src/components/git/branch-dropdown.tsx`
- Create: `apps/ui/src/components/git/history-column.tsx`
- Create: `apps/ui/src/routes/git-page.tsx`
- Modify: `apps/ui/src/routes/board.tsx` (Board | Git tabs in TopBar)
- Modify: `apps/ui/src/router.tsx` (child route)

**Interfaces:**
- Consumes: `api` (`apps/ui/src/lib/api.ts`), DTOs from `@aik/contracts` (Task 1), `Dialog`/`Button`/`Input` UI kit, `ConfirmDialog`-style dialogs (own thin dialogs here).
- Produces: route `/projects/$projectId/git` (usable by e2e, testids: `tab-git`, `git-branch-dropdown`, `git-status-error`, `git-staged-group`, `git-changes-group`, `git-commit-input`, `git-commit`, `git-push`, `git-pull`, `git-history`, `git-agent-busy`).

- [ ] **Step 1: Create `apps/ui/src/lib/git-view.ts`**

```ts
// apps/ui/src/lib/git-view.ts
import type {
  BranchListDTO, CommitFilesDTO, CommitLogDTO, GitBranchCheckoutRequest, GitBranchCreateRequest, GitCommitRequest,
  GitDiscardRequest, GitStageRequest, GitStatusDTO,
} from '@aik/contracts';
import { useEffect, useState } from 'react';
import { api } from './api.ts';

const POLL_MS = 5_000;

/** Status + 5 s poll while the tab is visible; refetch() after every mutation. */
export function useGitStatus(projectId: number) {
  const [status, setStatus] = useState<GitStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = async () => {
    try {
      setStatus(await api.get<GitStatusDTO>(`/projects/${projectId}/git/status`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void refetch();
    const t = setInterval(() => {
      if (!document.hidden) void refetch();
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  return { status, error, refetch };
}

export function useBranches(projectId: number) {
  const [branches, setBranches] = useState<BranchListDTO | null>(null);
  const refetch = async () => setBranches(await api.get<BranchListDTO>(`/projects/${projectId}/git/branches`));
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  return { branches, refetch: refetch };
}

export function useGitLog(projectId: number) {
  const [log, setLog] = useState<CommitLogDTO | null>(null);
  const load = async () => setLog(await api.get<CommitLogDTO>(`/projects/${projectId}/git/log?limit=50`));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  return { log, openFiles: async (sha: string) => api.get<CommitFilesDTO>(`/projects/${projectId}/git/commits/${sha}/files`) };
}

/** Every action returns a fresh GitStatusDTO so the panel redraws from one source. */
export const gitActions = {
  stage: (projectId: number, body: GitStageRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/stage`, body),
  unstage: (projectId: number, body: GitStageRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/unstage`, body),
  commit: (projectId: number, body: GitCommitRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/commit`, body),
  discard: (projectId: number, body: GitDiscardRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/discard`, body),
  push: (projectId: number) => api.post<GitStatusDTO>(`/projects/${projectId}/git/push`, {}),
  pull: (projectId: number) => api.post<GitStatusDTO>(`/projects/${projectId}/git/pull`, {}),
  checkout: (projectId: number, body: GitBranchCheckoutRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/branches/checkout`, body),
  createBranch: (projectId: number, body: GitBranchCreateRequest) => api.post<GitStatusDTO>(`/projects/${projectId}/git/branches/create`, body),
};
```

- [ ] **Step 2: Create `apps/ui/src/components/git/branch-dropdown.tsx`**

```tsx
// apps/ui/src/components/git/branch-dropdown.tsx
import { useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../ui/button.tsx';

export interface BranchDropdownProps {
  current: string | null;
  local: string[];
  remote: string[];
  disabled: boolean;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}

/** VS Code-style branch menu: search, locals with ✓, remotes, create-new. */
export function BranchDropdown({ current, local, remote, disabled, onCheckout, onCreate }: BranchDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  const match = (b: string) => b.toLowerCase().includes(query.toLowerCase());

  const choose = async (name: string) => {
    setOpen(false);
    setQuery('');
    await onCheckout(name);
  };
  const create = async () => {
    if (!creating) return;
    setOpen(false);
    setCreating(null);
    await onCreate(creating);
  };

  return (
    <div className="relative" data-testid="git-branch-dropdown">
      <Button
        size="sm"
        data-testid="git-branch-button"
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
        aria-expanded={open}
      >
        ⎇ {current ?? 'no branch'} ▾
      </Button>
      {open && (
        <div className="absolute left-0 top-8 z-40 w-64 rounded-panel border border-border-strong bg-[rgb(20_26_44/0.97)] p-2 shadow-panel">
          <input
            className="w-full rounded-control border border-border bg-black/30 px-2 py-1 text-xs"
            placeholder="Search branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">Local</p>
          <div className="max-h-48 overflow-y-auto">
            {local.filter(match).map((b) => (
              <button
                key={b}
                type="button"
                className={cn('flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-xs font-semibold hover:bg-surface-2', b === current && 'bg-accent-soft text-accent-soft-foreground')}
                onClick={() => void choose(b)}
              >
                <span className="w-3">{b === current ? '✓' : ''}</span>
                {b}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">Remote</p>
          <div className="max-h-32 overflow-y-auto">
            {remote.filter(match).map((b) => (
              <p key={b} className="px-2 py-1 text-xs text-muted-2">
                {b}
              </p>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-xs font-semibold">
            ＋ New branch
            <input className="flex-1 rounded-control border border-border bg-black/30 px-2 py-1 text-xs" value={creating ?? ''} onChange={(e) => setCreating(e.target.value)} />
            <Button size="sm" variant="primary" disabled={!creating} onClick={() => void create()}>Create</Button>
          </label>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `apps/ui/src/components/git/scm-panel.tsx`**

```tsx
// apps/ui/src/components/git/scm-panel.tsx
import type { GitFileDTO, GitStatusDTO } from '@aik/contracts';
import { useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../ui/button.tsx';
import { BranchDropdown } from './branch-dropdown.tsx';

const BADGE: Record<string, { cls: string; label: string }> = {
  M: { cls: 'bg-[rgb(59_130_246/0.25)] text-[#93c5fd]', label: 'M' },
  A: { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'A' },
  D: { cls: 'bg-[rgb(251_113_133/0.22)] text-[#fda4af]', label: 'D' },
  U: { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'U' },
  '?': { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'U' },
  R: { cls: 'bg-[rgb(139_92_246/0.22)] text-[#c4b5fd]', label: 'R' },
};

const tid = (p: string) => `git-file-${p.replace(/[^A-Za-z0-9-]/g, '_')}`;

function FileRow({ file, staged, onStage, onUnstage, busy }: {
  file: GitFileDTO; staged?: boolean; busy: boolean;
  onStage: (p: string) => void; onUnstage: (p: string) => void;
}) {
  const path = file.path.split('/').filter(Boolean).slice(0, -1).join('/');
  const name = file.path.split('/').pop() ?? file.path;
  const badge = BADGE[file.x === '?' ? '?' : staged ? file.x : file.y] ?? { cls: 'bg-surface-3 text-muted-2', label: staged ? file.x : file.y };
  return (
    <li className="flex items-center gap-2 border-t border-border px-2 py-1 font-mono text-xs first:border-t-0" data-testid={tid(file.path)}>
      {staged ? (
        <button type="button" aria-label={`Unstage ${name}`} className="text-muted-2 hover:text-accent-soft-foreground" disabled={busy} onClick={() => onUnstage(file.path)}>−</button>
      ) : (
        <>
          <button type="button" aria-label={`Stage ${name}`} className="text-muted-2 hover:text-accent-soft-foreground" disabled={busy} onClick={() => onStage(file.path)}>+</button>
          <button type="button" aria-label={`Discard changes in ${name}`} className="text-muted-2 hover:text-danger-foreground" disabled={busy} onClick={() => onDiscard(file.path)}>↺</button>
        </>
      )}
      <span className="truncate" title={file.path}>
        {path && <span className="text-muted-2">{path}/ </span>}
        <span>{name}</span>
      </span>
      <span className={cn('ml-auto grid h-4 w-4 place-items-center rounded-[5px] text-[10px] font-bold', badge.cls)}>{badge.label}</span>
    </li>
  );
}

export interface ScmPanelProps {
  status: GitStatusDTO;
  branches: { local: string[]; remote: string[] };
  busy: boolean; // mutation in flight locally
  onStage: (paths?: string[]) => Promise<void>;
  onUnstage: (paths?: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onDiscard: (path: string) => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onPush: () => Promise<void>;
  onPull: () => Promise<void>;
  syncBusy: boolean;
}

export function ScmPanel({ status, branches, busy, onStage, onUnstage, onCommit, onDiscard, onCheckout, onCreate, onPush, onPull, syncBusy }: ScmPanelProps) {
  const [message, setMessage] = useState('');
  const noRemote = status.upstream === null;
  const dirtySwitch = status.staged.length + status.changes.length > 0;
  const locked = status.agentBusy || syncBusy;
  const canCommit = !locked && !busy && status.staged.length > 0 && message.trim() !== '';

  return (
    <section className="flex min-h-0 w-80 shrink-0 flex-col gap-2 border-r border-border bg-glass p-3">
      <div className="flex items-center gap-2">
        <BranchDropdown current={status.branch} local={branches.local} remote={branches.remote} disabled={locked || busy || dirtySwitch} onCheckout={onCheckout} onCreate={onCreate} />
        <Button size="sm" data-testid="git-push" className="ml-auto" disabled={locked || busy || noRemote} title={noRemote ? 'No remote configured' : `Push ${status.ahead ?? 0}`} onClick={() => void onPush()}>
          Push{status.ahead ? ` ↑${status.ahead}` : ''}
        </Button>
        <Button size="sm" data-testid="git-pull" disabled={locked || busy || noRemote || dirtySwitch} title={dirtySwitch ? 'Stage your changes first' : noRemote ? 'No remote configured' : `Pull ${status.behind ?? 0}`} onClick={() => void onPull()}>
          Pull{status.behind ? ` ↓${status.behind}` : ''}
        </Button>
      </div>

      {status.agentBusy && (
        <p data-testid="git-agent-busy" role="status" className="rounded-control border border-warning/35 bg-warning/10 px-2 py-1 text-xs text-warning-foreground">
          ● Agent run in progress — Git actions paused
        </p>
      )}
      {status.mergeState !== 'none' && (
        <p role="alert" className="rounded-control border border-danger/35 bg-danger/10 px-2 py-1 text-xs text-danger-foreground">
          A merge/rebase is in progress — resolve it in your terminal, then commit there.
        </p>
      )}
      {dirtySwitch && (
        <p className="text-[11px] text-muted-2">Switching branches/pulling pauses until your changes are committed or discarded.</p>
      )}

      <textarea
        data-testid="git-commit-input"
        className="min-h-16 rounded-control border border-border bg-black/25 px-2.5 py-2 text-xs"
        placeholder={status.staged.length > 0 ? 'Message (Ctrl+Enter to commit)' : 'Stage changes to enable commit'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void onCommit(message.trim());
        }}
        disabled={locked}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" data-testid="git-commit" disabled={!canCommit} onClick={() => {
          const m = message.trim();
          setMessage('');
          void onCommit(m);
        }}>Commit</Button>
      </div>

      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-2">Staged Changes ({status.staged.length})</p>
      <ul data-testid="git-staged-group" className="rounded-panel border border-border bg-surface/50">
        {status.staged.map((f) => (
          <FileRow key={f.path} file={f} staged busy={locked || busy} onStage={(p) => void onStage([p])} onUnstage={(p) => void onUnstage([p])} />
        ))}
        {status.staged.length === 0 && <li className="px-2 py-1 text-xs text-muted-2">Empty</li>}
      </ul>

      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-2">Changes ({status.changes.length})</p>
      <ul data-testid="git-changes-group" className="rounded-panel border border-border bg-surface/50">
        {status.changes.map((f) => (
          <FileRow key={f.path} file={f} busy={locked || busy} onStage={(p) => void onStage([p])} onUnstage={(p) => void onUnstage([p])} />
        ))}
        {status.changes.length === 0 && <li className="px-2 py-1 text-xs text-muted-2">Clean tree</li>}
      </ul>

      <p className="mt-auto text-[11px] text-muted-2">Discarding a file asks for confirmation; discarding an untracked file deletes it.</p>
    </section>
  );
}
```

- [ ] **Step 4: Create `apps/ui/src/components/git/history-column.tsx`**

```tsx
// apps/ui/src/components/git/history-column.tsx
import type { CommitFilesDTO, CommitLogDTO } from '@aik/contracts';
import { useState } from 'react';

const short = (dateIso: string) => new Date(dateIso).toLocaleString();

export function HistoryColumn({ log, openFiles }: { log: CommitLogDTO | null; openFiles: (sha: string) => Promise<CommitFilesDTO> }) {
  const [open, setOpen] = useState<Record<string, CommitFilesDTO>>({});
  const toggle = async (sha: string) => {
    if (open[sha]) {
      setOpen((o) => { const next = { ...o }; delete next[sha]; return next; });
      return;
    }
    setOpen((o) => ({ ...o, [sha]: { projectId: 0, sha: '', files: [] } }));
    setOpen((o) => ({ ...o, [sha]: await openFiles(sha) }));
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="git-history">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">History</p>
      {(log?.commits ?? []).map((c) => (
        <article key={c.sha} className="mb-2 rounded-panel border border-border bg-surface/60 p-3">
          <button type="button" className="block w-full text-left" onClick={() => void toggle(c.sha)}>
            <p className="text-xs font-bold">{c.subject}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-2">{c.short} · {c.author} · {short(c.dateIso)}{c.parents.length > 1 ? ' · merge' : ''}</p>
          </button>
          {open[c.sha] && (
            <ul className="mt-2 border-t border-dashed border-border pt-2 font-mono text-[11px]">
              {open[c.sha]!.files.map((f) => (
                <li key={f.path} className="text-muted">{f.change} {f.path}</li>
              ))}
              {open[c.sha]!.files.length === 0 && <li className="text-muted-2">root commit / merge — no file list</li>}
            </ul>
          )}
        </article>
      ))}
      {log && log.commits.length === 0 && <p className="text-xs text-muted-2">No commits yet.</p>}
    </section>
  );
}
```

- [ ] **Step 5: Create `apps/ui/src/routes/git-page.tsx`**

```tsx
// apps/ui/src/routes/git-page.tsx
import type { ProjectDTO } from '@aik/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { HistoryColumn } from '../components/git/history-column.tsx';
import { ScmPanel } from '../components/git/scm-panel.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { gitActions, useBranches, useGitLog, useGitStatus } from '../lib/git-view.ts';

export function GitPage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const { status, error, refetch } = useGitStatus(id);
  const { branches, refetch: refetchBranches } = useBranches(id);
  const { log, openFiles } = useGitLog(id);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<string | null>(null);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await Promise.all([refetch(), refetchBranches()]);
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDiscard = () => {
    const p = discarding;
    setDiscarding(null);
    if (p) void run(() => gitActions.discard(id, { paths: [p] }));
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar data-testid="git-toolbar" title={project ? `${project.key} · ${project.name}` : 'Git'}>
        <div data-testid="project-tabs" className="inline-flex items-center gap-1 rounded-control border border-glass-border bg-surface-2/60 p-1">
          <Link to="/projects/$projectId" params={{ projectId: String(id) }} className="rounded-control px-2.5 py-1 text-xs font-semibold text-muted hover:text-foreground">Board</Link>
          <span aria-current="page" data-testid="tab-git" className="rounded-control bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-soft-foreground">Git</span>
        </div>
        <Link to="/" className="ml-2 text-sm font-semibold text-muted hover:text-foreground">← Projects</Link>
      </TopBar>
      {(error ?? actionError) && (
        <p role="alert" data-testid="git-status-error" className="px-4 py-2 text-sm text-danger-foreground">{error ?? actionError}</p>
      )}
      {status === null ? (
        <p className="p-4 text-sm text-muted">Loading repository status…</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ScmPanel
            status={status}
            branches={{ local: branches?.local ?? [], remote: branches?.remote ?? [] }}
            busy={busy}
            syncBusy={false}
            onStage={(paths) => run(() => gitActions.stage(id, paths ? { paths } : { all: true }))}
            onUnstage={(paths) => run(() => gitActions.unstage(id, paths ? { paths } : { all: true }))}
            onCommit={(message) => { setActionError(null); return run(() => gitActions.commit(id, { message })); }}
            onDiscard={(p) => setDiscarding(p)}
            onCheckout={(name) => { const dirty = status.staged.length + status.changes.length > 0; if (dirty) setSwitchTo(name); else void run(() => gitActions.checkout(id, { name })); }}
            onCreate={(name) => run(() => gitActions.createBranch(id, { name }))}
            onPush={() => run(() => gitActions.push(id))}
            onPull={() => run(() => gitActions.pull(id))}
          />
          <HistoryColumn log={log} openFiles={openFiles} />
        </div>
      )}
      <Dialog open={discarding !== null} title="Discard changes?" onClose={() => setDiscarding(null)}>
        <p className="text-sm text-muted">
          Discarding <span className="font-mono">{discarding}</span> restores the file from the last commit. If it is an untracked file it will be deleted permanently.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDiscarding(null)}>Keep changes</Button>
          <Button variant="danger" data-testid="git-discard-confirm" onClick={confirmDiscard}>Discard</Button>
        </div>
      </Dialog>
      <Dialog open={switchTo !== null} title="Switch with uncommitted changes?" onClose={() => setSwitchTo(null)}>
        <p className="text-sm text-muted">
          There are uncommitted changes. AI Kanban refuses to switch with a dirty tree (or to stash without asking). Stage or discard your changes first, or switch from the terminal.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setSwitchTo(null)}>Back</Button>
        </div>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 6: Register the route — modify `apps/ui/src/router.tsx`**

```tsx
import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { BoardPage } from './routes/board.tsx';
import { DashboardPage } from './routes/dashboard.tsx';
import { GitPage } from './routes/git-page.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId', component: BoardPage });
const gitRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId/git', component: GitPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, gitRoute, settingsRoute]),
  history: createHashHistory(),
});
```

- [ ] **Step 7: Add the tabs — modify `apps/ui/src/routes/board.tsx`**

Add to the TopBar children (before the search `<Input…>`), with imports `import { Link } from '@tanstack/react-router';` and `import { cn } from '../lib/cn.ts';` added at the top of the file:

```tsx
        <div data-testid="project-tabs" className="inline-flex items-center gap-1 rounded-control border border-glass-border bg-surface-2/60 p-1">
          <span aria-current="page" className="rounded-control bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-soft-foreground">Board</span>
          <Link
            to="/projects/$projectId/git"
            params={{ projectId: String(id) }}
            data-testid="tab-git"
            className="rounded-control px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:text-foreground"
          >
            Git
          </Link>
        </div>
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Accept as working only after the e2e in Task 11.

- [ ] **Step 9: Commit**

```bash
git add apps/ui/src/lib/git-view.ts apps/ui/src/components/git apps/ui/src/routes/git-page.tsx apps/ui/src/routes/board.tsx apps/ui/src/router.tsx
git commit -m "feat(ui): VS Code-style Git tab with branch dropdown and history (IDE-4X)"
```

---

### Task 9: Delete project — worktree purge, sanctioned purge transaction, DELETE route

**Files:**
- Modify: `apps/orchestrator/src/git/worktree.ts` (add `purgeForProject`)
- Create: `apps/orchestrator/src/projects/purge-repo.ts`
- Modify: `apps/orchestrator/src/projects/service.ts` (deps + `delete()`)
- Modify: `apps/orchestrator/src/api/routes/projects.ts` (DELETE)
- Modify: `apps/orchestrator/test/helpers/app.ts` (worktrees + purge-log options)
- Test: `apps/orchestrator/test/project-delete.test.ts` (create)

**Interfaces:**
- Consumes: `IMMUTABLE_TABLES` from `@aik/db` (`['story_events','reviews','review_findings','review_ac_results','verification_checks','merge_approvals']`), `projectBusyReason` (Task 2), `mutation()`/`parse()`, `WorktreeManager` and its private `contained()` logic.
- Produces: `WorktreeManager.purgeForProject(input: { projectId: number; repoPath: string }): Promise<string[]>` (discarded app-worktree paths, absolute, inside `<rootDir>`); `purgeProjectData(db: AikDb, projectId: number): { stories: number }`; `ProjectService.delete(id): Promise<{ ok: true; stories: number; discardedWorktrees: string[] }>`; route `DELETE /projects/:id` → `200 { ok: true, stories, discardedWorktrees }`; errors `404 NOT_FOUND`, `409 PROJECT_BUSY`, `500 PROJECT_PURGE_FAILED`.

- [ ] **Step 1: Write the failing test `apps/orchestrator/test/project-delete.test.ts`**

```ts
// apps/orchestrator/test/project-delete.test.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRuns, storyEvents } from '@aik/db';
import { purgeProjectData } from '../src/projects/purge-repo.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { buildTestApp } from './helpers/app.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', ...args], { cwd, encoding: 'utf8' });

describe('DELETE /projects/:id (sanctioned purge)', () => {
  it('removes the project row and its stories but not the folder on disk', async () => {
    const { inject } = await buildTestApp();
    const repo = makeTempRepo({ name: 'purge-me' });
    tempDirs.push(path.dirname(repo));
    const created = await inject('POST', '/projects', { name: 'X', key: 'PX', repoPath: repo });
    const id = JSON.parse(created.body).id as number;
    const res = await inject('DELETE', `/projects/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stories: 0, discardedWorktrees: [] });
    expect((await inject('GET', `/projects/${id}`)).statusCode).toBe(404);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# test\n');
  });

  it('refuses while an agent run is active, naming the story (PROJECT_BUSY)', async () => {
    const { inject, t } = await buildTestApp();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(agentRuns).values({
      storyId: s.id, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0',
      idempotencyKey: 'k-del-1', status: 'running', startedAt: new Date(1_700_000_000_000),
    }).run();
    const res = await inject('DELETE', `/projects/${p.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_BUSY');
    expect(res.json().error.message).toContain(s.key);
  });
});

describe('purgeProjectData (unit, append-only evidence)', () => {
  it('purges stories + append-only rows; the no-delete triggers are recreated afterwards', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(storyEvents).values({ storyId: s.id, type: 'create', actor: 'human', createdAt: new Date(1_700_000_000_000) }).run();
    // direct DELETE must fail while the append-only trigger is armed
    expect(() => t.db.$client.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
    const { stories } = purgeProjectData(t.db, p.id);
    expect(stories).toBe(1);
    // the trigger must be recreated inside the same transaction — fresh writes keep working:
    const fresh = seedProject(t.db);
    const s2 = seedStory(t.db, fresh.id);
    t.db.insert(storyEvents).values({ storyId: s2.id, type: 'create', actor: 'human', createdAt: new Date(1_700_000_000_000) }).run();
    expect(() => t.db.$client.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/orchestrator/test/project-delete.test.ts`
Expected: FAIL — `delete` not implemented / module missing

- [ ] **Step 3: Implement `apps/orchestrator/src/projects/purge-repo.ts`**

```ts
// apps/orchestrator/src/projects/purge-repo.ts
import { IMMUTABLE_TABLES, type AikDb } from '@aik/db';
import { sql } from 'drizzle-orm';

/** The tx handle drizzle passes into transaction callbacks. */
type PurgeTx = Parameters<Parameters<AikDb['transaction']>[0]>[0];

/**
 * The sanctioned §15.3 purge: drop append-only delete triggers, run the ordered
 * deletes for every project- or story-scoped table in one immediate transaction,
 * recreate the triggers. Never called outside ProjectService.delete.
 */
export function purgeProjectData(db: AikDb, projectId: number): { stories: number } {
  return db.transaction((tx) => purgeIn(tx, projectId), { behavior: 'immediate' });
}

const IMMUTABLE = IMMUTABLE_TABLES;
const dropTriggers = (tx: PurgeTx) => {
  for (const t of IMMUTABLE) tx.run(sql.raw(`DROP TRIGGER IF EXISTS "${t}_no_delete"`));
};
const recreateTriggers = (tx: PurgeTx) => {
  for (const t of IMMUTABLE) {
    tx.run(
      sql.raw(
        `CREATE TRIGGER "${t}_no_delete" BEFORE DELETE ON "${t}" BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`,
      ),
    );
  }
};

function purgeIn(tx: PurgeTx, projectId: number): { stories: number } {
  const storyIds = tx.$client.prepare('SELECT id FROM user_stories WHERE project_id = ?').all(projectId) as { id: number }[];
  const stories = storyIds.length;
  const IN = storyIds.length > 0 ? `(${storyIds.map((r) => String(r.id)).join(', ')})` : '(SELECT id FROM user_stories WHERE project_id = 0)';
  const S = `story_id IN ${IN}`;
  // Runs FIRST inside the transaction: user_stories FKs to plans/agent_runs are
  // `ON DELETE no action`, so the active back-references must be nulled before any DELETE.
  tx.run(sql`UPDATE user_stories SET active_plan_id = NULL, active_run_id = NULL WHERE project_id = ${projectId}`);
  const stmts: string[] = [
    `DELETE FROM model_usage WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE ${S})`,
    `DELETE FROM plans WHERE ${S}`, // clarifications cascade via plans.story_id
    `DELETE FROM review_ac_results WHERE review_id IN (SELECT id FROM reviews WHERE ${S}) OR acceptance_criterion_id IN (SELECT id FROM acceptance_criteria WHERE ${S})`,
    `DELETE FROM review_findings WHERE review_id IN (SELECT id FROM reviews WHERE ${S})`,
    `DELETE FROM reviews WHERE ${S}`, // before agent_runs (reviews.agent_run_id → agent_runs)
    `DELETE FROM verification_checks WHERE verification_run_id IN (SELECT id FROM verification_runs WHERE ${S})`,
    `DELETE FROM verification_runs WHERE ${S}`,
    `DELETE FROM merges WHERE ${S}`, // before pull_requests (merges.pull_request_id)
    `DELETE FROM merge_approvals WHERE ${S}`,
    `DELETE FROM pull_requests WHERE ${S}`,
    `DELETE FROM durable_jobs WHERE ${S}`,
    `DELETE FROM story_events WHERE ${S}`,
    `DELETE FROM story_dependencies WHERE ${S} OR depends_on_story_id IN ${IN}`, // both FK stems
    `DELETE FROM agent_runs WHERE ${S}`, // after plans/reviews/model_usage are cleared
    `DELETE FROM workspaces WHERE ${S}`, // after agent_runs
    `DELETE FROM outbox_events WHERE ${S}`,
    `DELETE FROM user_stories WHERE project_id = ${projectId}`,
    `DELETE FROM remote_sync_runs WHERE project_id = ${projectId}`,
    `DELETE FROM role_routes WHERE project_id = ${projectId}`,
    `DELETE FROM projects WHERE id = ${projectId}`,
  ];
  dropTriggers(tx);
  try {
    for (const s of stmts) tx.run(sql.raw(`${s};`));
  } finally {
    recreateTriggers(tx); // arm the append-only guards again, even on failure
  }
  return { stories };
}
```

> Execution notes (as landed): `model_usage.asset_run_id` does not exist in the schema — the `UPDATE model_usage SET asset_run_id = NULL` statement from the original block is dropped (the `DELETE FROM model_usage` below already clears the `agent_run_id` FK stem). The `user_stories` back-reference UPDATE runs FIRST inside the transaction. Production wiring also matters: `apps/orchestrator/src/app.ts` constructs `WorktreeManager({ rootDir: paths.worktrees, db })` and passes `worktreePurge: (input) => worktreeManager.purgeForProject(input)` into `ProjectService` — the original plan left that assignment unassigned.

- [ ] **Step 4: Add `WorktreeManager.purgeForProject` — modify `apps/orchestrator/src/git/worktree.ts`**

Add a new public method to the class (plus import `userStories` from `@aik/db` on the first import line):

```ts
  /** Purges every non-removed app worktree row for a project's stories (sanctioned by PM-1 §4.3). */
  async purgeForProject(input: { projectId: number; repoPath: string }): Promise<string[]> {
    if (!this.db) return [];
    const rows = this.db
      .select({ id: workspaces.id, path: workspaces.path })
      .from(workspaces)
      .innerJoin(userStories, eq(workspaces.storyId, userStories.id))
      .where(and(eq(userStories.projectId, input.projectId), ne(workspaces.status, 'removed')))
      .all();
    const discarded: string[] = [];
    for (const row of rows) {
      const p = this.contained(path.isAbsolute(row.path) ? path.relative(this.rootDir, row.path) : row.path);
      try {
        execFileSync('git', ['worktree', 'remove', '--force', p], { cwd: input.repoPath, encoding: 'utf8' });
      } catch {
        fs.rmSync(p, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: input.repoPath, encoding: 'utf8' });
      } catch {
        // ignore
      }
      this.db.update(workspaces).set({ status: 'removed', removedAt: new Date(this.now()) }).where(eq(workspaces.id, row.id)).run();
      discarded.push(p);
    }
    return discarded;
  }
```

- [ ] **Step 5: Implement `ProjectService.delete` + route — modify `apps/orchestrator/src/projects/service.ts`**

Add to the imports: `import { purgeProjectData } from './purge-repo.ts';` and `import { projectBusyReason } from './busy.ts';`. Extend the constructor/deps:

```ts
export interface ProjectServiceDeps {
  db: AikDb;
  now?: Clock;
  worktreePurge?: (input: { projectId: number; repoPath: string }) => Promise<string[]>;
  purgeLog?: (line: string) => void;
}

export class ProjectService {
  private readonly db: AikDb;
  private readonly now: Clock;
  private readonly deps: ProjectServiceDeps;

  constructor(deps: ProjectServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? systemClock;
    this.deps = deps;
  }
```

(replacing the existing constructor — keep every existing method unchanged) then add the new method:

```ts
  async delete(id: number): Promise<{ ok: true; stories: number; discardedWorktrees: string[] }> {
    const project = this.get(id); // 404 unknown
    const reason = projectBusyReason(this.db, id);
    if (reason) throw new ApiHttpError(409, 'PROJECT_BUSY', reason);
    let discardedWorktrees: string[] = [];
    if (this.deps.worktreePurge) {
      try {
        discardedWorktrees = await this.deps.worktreePurge({ projectId: id, repoPath: project.repoPath });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ApiHttpError(500, 'PROJECT_PURGE_FAILED', `Could not remove app-generated worktrees: ${detail}`, { retryable: true });
      }
    }
    const result = purgeProjectData(this.db, id);
    this.deps.purgeLog?.(
      `${new Date(this.now()).toISOString()} purge project=${project.key} id=${id} stories=${result.stories} worktrees=${discardedWorktrees.length} ok=true`,
    );
    return { ok: true, stories: result.stories, discardedWorktrees };
  }
```

Finally modify `apps/orchestrator/src/api/routes/projects.ts` — the `registerProjectRoutes` body gains:

```ts
  mutation(app, deps, 'DELETE', '/projects/:id', async (req) => {
    const id = parse(IdParams, req.params).id;
    return { status: 200, body: await deps.projects.delete(id) };
  });
```

with the inject shape per `mutation()` (returns `{status, body}`).

- [ ] **Step 6: Extend `buildTestApp` for worktree purging — modify `apps/orchestrator/test/helpers/app.ts`**

Import `WorktreeManager` and extend options + construction:

```ts
  const worktrees = options?.worktrees ?? makeTempDir('aikanban-test-wt-');
  const purgeLines: string[] = [];
  const worktreeManager = new WorktreeManager({ rootDir: worktrees, db: t.db, now });
  const projects = new ProjectService({ db: t.db, now, worktreePurge: (input) => worktreeManager.purgeForProject(input), purgeLog: (line) => purgeLines.push(line) });
```

returning `purgeLines` and `worktrees` in the payload: `{ t, app, inject, bus, purgeLines, worktrees, services: {...} }`. Add `import { makeTempDir } from './temp.ts';` and add `worktrees?: string` to the options type.

- [ ] **Step 7: Run to verify it passes (add this direct-map test too)**

Append to `apps/orchestrator/test/project-delete.test.ts`:

```ts
describe('ProjectService.delete with a real worktree manager (temp root)', () => {
  it('removes app worktrees but not the repo folder', async () => {
    const t = createTestDb();
    const now = () => new Date(1_700_000_000_000);
    const wtRoot = makeTempDir('aikanban-test-wt2-');
    const repo = makeTempRepo({ name: 'with-wt' });
    tempDirs.push(wtRoot, path.dirname(repo));
    const mgr = new WorktreeManager({ rootDir: wtRoot, db: t.db, now });
    const svc = new ProjectService({ db: t.db, now, worktreePurge: (input) => mgr.purgeForProject(input) });
    const created = await svc.create({ name: 'WT', key: 'WT', repoPath: repo });
    const story = seedStory(t.db, created.id);
    const ws = await mgr.ensureStoryWorktree({ repoPath: repo, storyKey: 'WT-1', baseBranch: 'main', storyId: story.id });
    const result = await svc.delete(created.id);
    expect(result.ok).toBe(true);
    expect(result.discardedWorktrees).toHaveLength(1);
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    expect(() => svc.get(created.id)).toThrow(/not found/i);
  });
});
```

Run: `npx vitest run apps/orchestrator/test/project-delete.test.ts apps/orchestrator/test/busy.test.ts apps/orchestrator/test/projects.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add apps/orchestrator/src/projects apps/orchestrator/src/git/worktree.ts apps/orchestrator/src/api/routes/projects.ts apps/orchestrator/test/helpers/app.ts apps/orchestrator/test/project-delete.test.ts
git commit -m "feat(orchestrator): DELETE /projects/:id — sanctioned purge with worktree pruning (PM-1)"
```

---

### Task 10: Dashboard — delete menu with two-step confirmation

**Files:**
- Modify: `apps/ui/src/routes/dashboard.tsx` (card `⋯` + `DeleteProjectDialog`)

**Interfaces:**
- Consumes: `api.del` (`apps/ui/src/lib/api.ts`), `Dialog`/`Button`.
- Produces: `DeleteProjectDialog` (internal to the file, `data-testid="project-delete-step1"`, `project-delete-step2`, `project-delete-confirm`, input `project-delete-key-input`), card menu `data-testid="project-card-actions"` on every card.

- [ ] **Step 1: Add the dialog component (paste above `DashboardPage()` in `apps/ui/src/routes/dashboard.tsx`)**

```tsx
import { Dialog } from '../components/ui/dialog.tsx';

/**
 * Detach-only delete, two steps: step 1 explains exactly what happens and what
 * is never touched; step 2 requires typing the project KEY. The parent owns
 * `stage: 'none' | 'explain' | 'confirm'` so both stacked dialogs share state.
 */
function DeleteProjectDialog({ project, stage, setStage, onDeleted }: {
  project: ProjectDTO;
  stage: 'explain' | 'confirm' | 'none';
  setStage: (s: 'none' | 'explain' | 'confirm') => void;
  onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const callDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/projects/${project.id}`);
      setStage('none');
      await onDeleted();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={stage === 'explain'} title="Delete project from AI Kanban?" onClose={() => setStage('none')}>
        <p className="text-sm text-muted" data-testid="project-delete-step1">
          Removes <span className="font-semibold text-foreground">{project.key} · {project.name}</span> from AI Kanban — with its stories and any app-generated worktrees.{' '}
          <span className="text-foreground">Your folder on disk and its git history are never touched:</span>{' '}
          <span className="font-mono">{project.repoPath}</span>
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-danger-foreground">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setStage('none')}>Keep project</Button>
          <Button variant="danger" disabled={busy} onClick={() => setStage('confirm')}>Continue…</Button>
        </div>
      </Dialog>
      <Dialog open={stage === 'confirm'} title={`Type ${project.key} to confirm`} onClose={() => setStage('none')}>
        <p className="text-sm text-muted" data-testid="project-delete-step2">This cannot be undone. The stories move out of AI Kanban together with the project.</p>
        <input data-testid="project-delete-key-input" aria-label={`Type ${project.key} to confirm`} className="mt-3 w-full rounded-control border border-border bg-black/25 px-2.5 py-2 text-sm" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} />
        {error && <p role="alert" className="mt-3 text-sm text-danger-foreground">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setStage('none')}>Cancel</Button>
          <Button variant="danger" disabled={busy || typed !== project.key} data-testid="project-delete-confirm" onClick={() => void callDelete()}>Delete project</Button>
        </div>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Wire the card menu — inside `projects.map((p) => <Card …>)`**

Add at the top of `DashboardPage`:

```tsx
  const [deleteStageProject, setDeleteStageProject] = useState<ProjectDTO | null>(null);
  const [deleteStage, setDeleteStage] = useState<'none' | 'explain' | 'confirm'>('none');
```

and inside the mapped `Card` (after the real badges `<div className="mt-3 flex flex-wrap …">` that already renders base branch + ready badge):

```tsx
                      <div className="mt-2 flex items-center justify-end">
                        <button
                          type="button"
                          data-testid="project-card-actions"
                          aria-label={`Project actions for ${p.key}`}
                          className="rounded-control px-2 py-1 text-sm font-bold text-muted-2 hover:bg-surface-2 hover:text-foreground"
                          onClick={() => {
                            setDeleteStageProject(p);
                            setDeleteStage('explain');
                          }}
                        >
                          ⋯
                        </button>
                      </div>
```

and directly after the ternary whose second branch is `<RepositoryBrowser onProjectCreated={load} />` (insert right after its closing `)}`), so the dialog renders under both dashboard tabs:

```tsx
      {deleteStageProject && (
        <DeleteProjectDialog
          project={deleteStageProject}
          stage={deleteStage}
          setStage={setDeleteStage}
          onDeleted={load}
        />
      )}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/routes/dashboard.tsx
git commit -m "feat(ui): project delete with sanctioned two-step confirmation dialog (PM-1)"
```

---

### Task 11: E2E — Git tab smoke and delete flow

**Files:**
- Test: `e2e/tests/git-tab.spec.ts` (create) — playwright's `testDir` is `./tests`, so the spec lives under `e2e/tests/`, not `e2e/`.

**Interfaces:**
- Consumes: `launchApp`, `waitReady`, `apiCall`, `makeTempRepo`, `makeTempDir` from `e2e/fixtures.ts`; the built app (run `npm run build` first). Note `e2e/fixtures.ts` already re-exports `makeTempRepo`/`makeTempDir` from `apps/orchestrator/test/helpers/temp.ts`.
- Produces: confidence that stage→commit→delete works through the real bridge, and that the folder survives deletion.

- [ ] **Step 1: Write `e2e/tests/git-tab.spec.ts`**

```ts
// e2e/tests/git-tab.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('git tab: stage, commit, then delete detaches without touching the folder', async () => {
  const repo = makeTempRepo({ name: 'wmk-e2e' });
  const dataDir = makeTempDir('aikanban-e2e-git-');
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);

  const created = await apiCall(page, 'POST', '/projects', { name: 'We Made Kits', key: 'WMK', repoPath: repo });
  expect(created.status).toBe(201); // POST /projects answers 201 (routes/projects.ts)
  await page.reload(); // the dashboard listed projects before the bridge create — refresh to see the card
  await waitReady(page);

  // dirty the working tree, then stage + commit it from the Git tab
  fs.writeFileSync(path.join(repo, 'notes.md'), 'hello');
  await page.getByTestId('project-card-WMK').getByRole('link').click();
  await page.getByTestId('tab-git').click();
  await page.getByTestId('git-file-notes_md').waitFor();
  await page.getByTestId('git-file-notes_md').getByRole('button', { name: 'Stage notes.md' }).click();
  await expect(page.getByTestId('git-staged-group').locator('li')).toHaveCount(1);
  await page.getByTestId('git-commit-input').fill('e2e: notes');
  await page.getByTestId('git-commit').click();
  await expect(page.getByTestId('git-changes-group').locator('li')).toHaveText(['Clean tree']);

  // delete via the dashboard two-step dialog (hash-nav back — the board has no back link by design)
  await page.evaluate(() => { location.hash = '#/'; });
  await page.getByTestId('project-card-actions').click();
  await expect(page.getByTestId('project-delete-step1')).toBeVisible();
  await page.getByRole('button', { name: 'Continue…' }).click();
  await page.getByTestId('project-delete-key-input').fill('WMK');
  await page.getByTestId('project-delete-confirm').click();

  // the real folder survived, byte for byte; the app list is empty again
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# test\n');
  const list = await apiCall<{ id: number }[]>(page, 'GET', '/projects');
  expect(list.body).toEqual([]);
  await app.close();
});

test('git tab keeps commit disabled on a clean tree', async () => {
  const repo = makeTempRepo({ name: 'wmk-e2e-2' });
  const dataDir = makeTempDir('aikanban-e2e-git2-');
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  await apiCall(page, 'POST', '/projects', { name: 'Two', key: 'TWO', repoPath: repo });
  await page.reload();
  await waitReady(page);
  await page.getByTestId('project-card-TWO').getByRole('link').click();
  await page.getByTestId('tab-git').click();
  await expect(page.getByTestId('git-commit')).toBeDisabled(); // the input stays editable; the button is the guard
  await app.close();
});
```

> Notes: `apiCall` auto-signs POSTs with an idempotency key and returns `{ status, body }`; `POST /projects` answers `201`. The `page.reload()` after each bridge-created project is required because the dashboard fetched its list before the create. Return trips use `location.hash = '#/'` since the board intentionally has no back link.

- [ ] **Step 2: Run the e2e**

```bash
npm run build
npm run e2e -- --grep "git tab"
```
Expected: PASS (2 tests). Debug rule: if the app shows orchestrator 'starting', re-check `waitReady` handling; tests must always run against temp data dirs (`AIK_DATA_DIR` inside `launchApp`).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/git-tab.spec.ts
git commit -m "test(e2e): Git tab stage/commit and sanctioned project delete"
```

---

### Task 12: Docs, repo-wide gates, plan completion

**Files:**
- Modify: `README.md` (feature bullets)

- [x] **Step 1: README — under the commands table add a "Project lifecycle" short section**

```markdown
## Project lifecycle

- **Add project** — dashboard → pick an existing git repository; AI Kanban adopts the checkout
  (branch, origin, history) and never modifies it outside approved runs.
- **Git tab** — per project: stage/unstage/commit/discard, push/pull (`--ff-only`), branch
  dropdown with create-new, and history. Mutations pause while an agent run or merge is active.
- **Delete project** — dashboard card `⋯` → two-step confirm. Detaches the project and cleans
  app-owned worktrees (`%LOCALAPPDATA%\AiKanban\wt`); your folder on disk and `.git` are never touched.
```

- [x] **Step 2: Repo-wide verification gate (AGENTS.md)**

```bash
npm run check:pins && npm run lint && npm run typecheck && npm test
```
Expected: all PASS. Run `npm run build && npm run e2e` once if time allows (e2e needs the build).

- [x] **Step 3: Commit the docs**

```bash
git add README.md docs/superpowers/plans/2026-10-24-delete-project-and-git-view.md
git commit -m "docs: project lifecycle — add, git tab, delete"
```

- [x] **Step 4: Mark the plan complete**

Update `docs/superpowers/plans/` execution-status notes following the repo convention used by prior plans (grep `docs: mark the .* plan complete` in git history for the pattern used before, e.g. commit `ea9f6b2`).

## Self-Review (completed against the 2026-10-24 spec)

1. **Spec coverage:** §4 PM-1 → Tasks 2, 9, 10 (busy guard, purge, two-step UI); §5 status/log/stage/commit/discard/push/pull/branches → Tasks 3–8; guard matrix → Tasks 5–6 (`ApiHttpError` codes); §6 security (stripCredentials, no new packages, orchestrator-only push) → Tasks 5–6 code paths; §7 tests → per-task + e2e Task 11. Spec §4.4 migration is intentionally replaced by explicit ordered deletes (Task 9) — noted in File Structure.
2. **Code blocks are final:** every code block is complete and runnable — no in-file "correction" placeholders remain (verified by sweep). Fixture note: `makeTempRepo()` seeds branch `main`, while `makeTempRemoteAndClone()` renames the seed branch to `trunk`, so remote tests assert `origin/trunk` and push `trunk`.
3. **Type consistency:** `GitFileDTO{x,y}`, `GitStatusDTO` fields, service method names (`stage/unstage/commit/discard/push/pull/checkout/createBranch`), `purgeProjectData(db, projectId)`, and `RegisterGitViewRoutes` shape line up across Tasks 1–11; UI calls `gitActions.*` exactly as defined in Task 8 Step 1.

## Execution Handoff

Plan complete — saved to `docs/superpowers/plans/2026-10-24-delete-project-and-git-view.md`.

**1. Subagent-Driven (recommended)** — fresh subagent per task with review between tasks.
**2. Inline Execution** — execute tasks in this session with checkpoints.

