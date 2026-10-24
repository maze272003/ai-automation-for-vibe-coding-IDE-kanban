# Phase 5 Sub-Project 5.1: Project Management — Detach Project (PM-1) and Git Working-Tree View (IDE-4, extended) Design Specification

| | |
|---|---|
| **Date** | 2026-10-24 |
| **Status** | Approved design (user-validated via mockups); implementation plan not yet written |
| **Scope** | Sub-project 5.1: PM-1 (new story: delete/detach a project) and IDE-4 (branch and commit history — pulled forward from Phase 5 P2 and extended with staging, commit, push, pull and a branch dropdown) |
| **Parent Spec** | `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §12 (repository integration), §13 (local git execution), §15.3/§15.4 (schema, purge and retention), §13.6 + S19 (safe worktree cleanup), §26 (backlog: FND-9, IDE-4) |
| **Roadmap position** | Phase 5 (IDE experience) pulled forward on explicit user request, before Phase 4 REL-2…REL-8 |

---

## 1. Executive summary

The user manages several already-git-connected projects. Add/delete lifecycle is half-built: `ProjectService.create()` adopts existing git repos (never touching them), but there is **no way to remove a project**, and the app's git powers (worktrees, merge, publish, credential helper) are invisible to the user — there is no branch/status/history surface in the UI.

Two user-facing features close this:

1. **PM-1 — Delete (detach) a project.** A `DELETE /projects/:id` flow that removes the project, its stories and every app-generated worktree, **while never touching the user's folder on disk or its `.git`**. Deletion follows the parent spec's sanctioned purge procedure (§15.3): drop append-only triggers, cascade-delete project-scoped rows in one transaction, recreate triggers, and write an audit line to `logs\audit-purge.log`. It is refused while an agent run or merge is active for that project.
2. **IDE-4X — Git view.** A per-project **Board | Git** tab shaped like VS Code's Source Control panel (user-approved mockup "variant A + branch dropdown"): branch switcher with search/local/remote/create actions, per-file stage/unstage/discard lists, commit box, push/pull with ahead/behind counters, and a History column with expandable commit file lists. All git powers reuse the orchestrator's existing `git()` wrapper and named-pipe credential server, so already-connected HTTPS remotes just work.

The existing "Add project" flow is **unchanged**: it already requires and adopts what git put on disk (§ decision log: "no re-init, no second `git add` wizard").

---

## 2. Parent-spec traceability and amendments

| Parent-spec item | Use in this design |
|---|---|
| FND-9 (P0, done) | Project registration exists; PM-1 completes the lifecycle with removal |
| IDE-4 (P2, S) | Pulled forward into this sub-project and extended (staging/commit/sync), growing Cx S → M |
| §15.3 "Purging a project" | PM-1 delete = this exactly-sanctioned procedure; the app current-behaviour gap is that only it is described, not implemented |
| §15.4 retention table | **Amended:** the retention idea "archive on project removal" is replaced by the sanctioned purge for project removal; the `archived` status value stays unused (reserved). User decision 2026-10-24: detach-only, no archive mode in v1 |
| §13.6 + S19 | Worktree pruning during purge follows realpath containment and explicit-discards-are-logged rules |
| §13.4 + GH-5 | Push/pull go through the named-pipe credential server; git prompts stay disabled |
| S7 | The orchestrator remains the only process that pushes; the user's push is an explicit orchestrator-executed action |

**No changes to:** the state machine, `WorkflowService` responsibilities, story status rules, provider/model routing, or the security boundary. Deviations from the parent spec are limited to the §15.4 amendment above plus the two-step confirmation that the sanctioned purge procedure itself already mandates.

---

## 3. Scope and non-goals

**In scope**
- `DELETE /projects/:id` end to end: service, route, idempotency, purge transaction, worktree prune, UI menu + two-step dialog.
- Git view: status, log (+ commit files), stage/unstage, commit, discard, push, pull, branch list/checkout/create, agent-busy lock surface, UI panels (SCM + history), polling refresh.
- Contracts (`packages/contracts`), DB FK cascade migration where SQLite table rebuilds are required.

**Out of scope (explicit non-goals, YAGNI)**
- Re-init git for non-git folders (add flow unchanged — user decision).
- Merge/rebase conflict resolution UI; diverged pulls surface a terminal hint instead.
- Archive mode, undelete, restore, or soft-delete visibility switches.
- Automatic staging/commit of the user's own changes for story purposes (agent candidates keep using worktrees per §13.3).
- SSE/push-based git events (the tab polls; §5.5).
- File staging per-submodule, submodules/LFS boundary handling beyond upstream git behaviour.

---

## 4. PM-1: Delete (detach) a project

### 4.1 Semantics

Detach = the project leaves the app completely. The user's on-disk folder and `.git` history are **never** touched: not read-modified, not renamed, no git command runs against it at delete time (the repo may also be missing/`unavailable` — deletion still works, because app-side artefacts are the only mutation targets). Re-adding the same folder later behaves like first-time registration.

### 4.2 API

- `DELETE /projects/:id` — wrapped in `mutation()` idempotency (same replay/hash contract as `POST /projects`).
  - `200` → `{ ok: true }`, success stored and replayed by `mutation()` for repeated keys.
  - `404 NOT_FOUND` — unknown id.
  - `409 PROJECT_BUSY` — an agent run, verification, or merge is active for the project; the error names the story (e.g. `Story WMK-2 is IN_PROGRESS`). Applies also to delete-while-unavailable (busy has meaning even then).
  - `500 PROJECT_PURGE_FAILED` — pruning partially failed; the DB transaction was **not** entered; retryable. The failed worktree paths are listed in the error detail.

### 4.3 Order of operations

1. **Busy guard:** derive from existing state: any story in a non-terminal status with a live run (`active_run_id`), any `workspaces` row not terminally cleaned, or a merge in progress (`merges`/`merge_approvals` with non-terminal outcome). Exact enumeration of signals is plan-level work against `schema.ts`.
2. **Worktree prune (app-owned copies only):** for every `workspaces` row of this project (kinds `story|review|verify|postmerge` under `<data>\wt`), remove the row and its directory via `WorktreeManager`, following §13.6/S19: realpath containment before touching paths, no removal outside `<data>\wt`, and **explicit-discards logging** (an unclean or unmerged worktree is discarded and recorded). A prune failure aborts before entering the DB transaction (409/500 wiring above).
3. **Purge transaction** — the §15.3 sanctioned procedure, one transaction:
   - drop the append-only triggers (`story_events_no_delete`, `reviews_no_delete`, `merge_approvals_no_delete`, …; plan enumerates from `0001_immutability_triggers.sql`),
   - cascade-delete project-scoped rows: `user_stories` (+ acceptance criteria, plans, clarifications, story dependencies, verification checks, review findings, merge approvals, runs, …), `remote_sync_runs`, `role_routes`, `workspaces` (project scope), then the `projects` row,
   - recreate the triggers,
   - `repository_connections` rows are **kept** (they are keyed to GitHub repos, not projects; projects unlink via `SET NULL`). GitHub connections are never touched.
4. **Audit:** one line to `logs\audit-purge.log`: timestamp, project id/key, stories deleted count, worktrees discarded, trigger-recreation OK. This parallels §15.3's requirement; the redactor stays in the write path per AGENTS.md.

### 4.4 Schema/migration

Only FK/ON-DELETE alignment for tables whose children lack cascade today (e.g. `user_stories.project_id` has none). Generated with `npm run db:generate`; SQLite table rebuilds happen through drizzle's migration machinery; the pre-migration timestamped `VACUUM INTO` backup already exists in `openDatabase()`.

### 4.5 UI

- Dashboard project card gains a `⋯` menu with **Delete…** (danger item).
- **Two-step confirmation** (mandated by §15.3's "explicit two-step confirmation"):
  1. Step 1 dialog reuses `confirm-dialog.tsx`: explains detach semantics, counts stories ("This removes WMK · We Made Kits and its 4 stories from AI Kanban. Your folder at `C:\dev\we-made-kits` and its git history are untouched."), lists worktree discard count if any.
  2. Step 2 dialog requires **typing the project KEY** (`WMK`) to enable the final confirm button.
- While an agent run is active, the menu item is visible but disabled with the busy reason (mirrors the 409).

---

## 5. IDE-4X: Git working-tree view

### 5.1 Scope shape

The Git tab operates on the project's **main checkout at `repoPath`** — the working tree the user opened — not on story worktrees. Agent runs keep working in `<data>\wt` worktrees; their interaction with the main tree continues to be mediated by merge (§13.5), which is why git mutations pause during agent activity (§5.4).

### 5.2 Routes and contracts (`packages/contracts/src/git-view.ts`, new)

| Method + path | Purpose | Returns |
|---|---|---|
| `GET /projects/:id/git/status` | Branch, upstream tracking, ahead/behind, file lists, merge-state, agent-busy | `GitStatusDTO` |
| `GET /projects/:id/git/log?limit=50` | Recent commits (subject/author/date/hash/parents) | `CommitLogDTO` |
| `GET /projects/:id/git/commits/:sha/files` | Changed files for the history detail row | `CommitFilesDTO` |
| `GET /projects/:id/git/branches` | Branch names for the dropdown (search happens client-side) | `BranchListDTO` |
| `POST /projects/:id/git/stage` `{paths[] \| all}` | `git add -- <paths>` | `GitStatusDTO` |
| `POST /projects/:id/git/unstage` `{paths[] \| all}` | `git reset -q HEAD -- <paths>` | `GitStatusDTO` |
| `POST /projects/:id/git/commit` `{message, paths?}` | Stage-then-commit when paths given; staged commit otherwise | `GitStatusDTO` |
| `POST /projects/:id/git/discard` `{paths[]}` | `git restore -- <tracked>` / delete untracked file rows | `GitStatusDTO` |
| `POST /projects/:id/git/push` | `git push -u origin HEAD` via `gitWithCredentials()` | `GitStatusDTO` |
| `POST /projects/:id/git/pull` | `git pull --ff-only` via `gitWithCredentials()` | `GitStatusDTO` |
| `POST /projects/:id/git/branches/checkout` `{name}` | `git checkout <name>` (local refs only) | `GitStatusDTO` |
| `POST /projects/:id/git/branches/create` `{name, from?}` | `git check-ref-format --branch` then `git switch -c` (checks out new branch) | `GitStatusDTO` |

All POSTs are idempotency-wrapped `mutation()` routes. DTOs are zod-defined next to `projects.ts` conventions. Untracked files appear in `status` exactly as porcelain shows them (`??` → badge `U`, user-visible added files need `git add` first).

### 5.3 GitViewService (`apps/orchestrator/src/git/view-service.ts`, new)

- Constructor takes `{ db, now }` and resolves the project via `ProjectService.get()`; 404s if the project is unknown or its repo is dead (`unavailable`) → commands return `409 NOT_IN_WORKING_TREE` with the refresh-hint.
- **Status composition:** `git status --porcelain=v1 --branch` (branch, upstream, file states, merge/rebase conflicts) + `git rev-list --left-right --count <upstream>...HEAD` when an upstream is configured. Parsing is a pure, unit-tested function `parsePorcelainStatus()`.
- **Log:** `git log -n <limit> --date=iso-strict --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P` (unit-group separators; merge flags derived from `%P`). Commit file detail via `git diff-tree --name-status -r --no-renames <sha>`.
- **Commit:** message required (zod non-empty); identity never provided by the app — the commit uses the repo's `user.name`/`user.email` (§13.1 "the repo's own identity"), failing with `IDENTITY_MISSING` (§5.4) if unset. Empty-result commits surface `NOTHING_TO_COMMIT`.
- **Push:** `gitWithCredentials()` (device-flow token injection at the last moment, §13.4); without an upstream, `-u origin HEAD` sets one.
- **Pull:** always `--ff-only`. This is a safety decision, not a convenience one: pulling into a dirty tree is refused, and divergent histories are never auto-merged. Hint text on `DIVERGED`: "resolve in your terminal (rebase/merge), then pull again".
- **Branches:** checkout only switches to an already-existing local ref; create validates the name with `git check-ref-format` and switches to it after creation. Remote branches are listed read-only for orientation.
- **agentBusy:** computed from the same signals as PM-1's busy guard (§4.3 step 1) — one small shared helper, used by both features, so the definitions cannot drift.

### 5.4 Guardrail matrix (named error codes → HTTP via `ApiHttpError`)

| Code | HTTP | Raised when | User meaning |
|---|---|---|---|
| `PROJECT_BUSY` | 409 | agent run / verify / merge active for this project | "Agent at work — Git actions pause until it finishes." |
| `WORKING_TREE_DIRTY` | 409 | unstaged+staged changes exist during pull / branch-switch | Panel says: pull and switch pause until changes are stage/push/discard'd; switching offers a stash |
| `DIVERGED` | 409 | pull needs merge | Terminal hint |
| `NO_REMOTE` | 409 | push/pull with no `origin` | Hint: add a remote to enable sync |
| `IDENTITY_MISSING` | 400 | commit without repo identity | Hint: set `user.name`/`user.email` in the repo |
| `NOT_IN_WORKING_TREE` | 409 | project repo deleted/moved | Refresh availability hint |
| `NOTHING_TO_COMMIT` | — | commit with an empty staged set | The panel disables Commit on a clean tree instead |
| `MERGE_IN_PROGRESS` | 409 | unmerged entries (`UU`) present | "Resolve in your terminal or editor, then commit." Git mutations stay paused |
| `BRANCH_NOT_FOUND` / `BRANCH_EXISTS` / `BRANCH_NAME_INVALID` | 400 | checkout/create regimes | Dropdown message |

`GitError` stderr (including any credential remnants) is passed through `stripCredentials` before explanation — the redaction rule applies at the logging layer regardless (AGENTS.md).

### 5.5 UI (`apps/ui`)

- **Route shape:** Board stays at `/projects/$projectId`; a `Board | Git` tab pair lives in the project `TopBar`; Git is its own route at `/projects/$projectId/git` (matches the existing route-per-screen pattern and keeps e2e targeting simple).
- **`components/git/` new components:** `ScmPanel` (branch bar, commit box, staged/changes groups, agent-busy banner), `ChangesGroup` + `FileRow` (badge `M`/`A`/`D`/`U`, hover actions `+`, `−` staged, `↺` discard), `CommitBox`, `SyncButtons` (`↑↑` push, `↓↓` pull with counters), `BranchDropdown` (search, Local with ✓, `agent` tag for story branches, remote group, “＋ Create new branch…”), `HistoryColumn` (records expandable via commit-files endpoint).
- **Confirm dialogs** (reusing `confirm-dialog.tsx`): discard (warns untracked discard deletes the file), branch-switch-with-changes (offers stash-then-switch; visual only reflects § mockup promise), delete project (§4.5).
- **States:** no remote → Push/Pull disabled with reason; clean tree → commit disabled; busy → yellow banner, buttons disabled; unavailable folder → inline redirect to availability hint.
- **Refresh:** status/log poll every 5 s while the tab is focused, refetch after every mutating call; no SSE additions.
- **testids** follow the e2e naming style: `tab-git`, `git-branch-dropdown`, `git-file-<state>`, `git-staged-group`, `git-commit-input`, `git-push`, `git-pull`, `project-card-actions`, `project-delete-step1`, `project-delete-step2`.

---

## 6. Security review

- **The orchestrator remains the only push path** (S7 preserved; agents still never push nor see credentials).
- **Detached folder safety:** realpath containment stays in force for worktree paths; nothing outside `<data>\wt` and the project DB rows is deleted (the user's folder is by contract never a target).
- **Credentials:** token injection stays behind `gitWithCredentials()`; `stripCredentials` and the write-time redactor cover status/log/push error paths; the audit-purge file records counts, never content.
- **Prompt injection surface:** commit messages, branch names, author names, and file paths are untrusted repo content — rendered as text nodes (no HTML) and length-capped in DTOs; zod caps them at plan-defined limits.
- **No new dependencies, secrets, or env vars.** The exact-pins rule (AGENTS.md) is unaffected because no packages are added at all.

---

## 7. Testing strategy

**Orchestrator unit/integration** (`apps/orchestrator/test/`; real git repos exclusively under the OS temp dir asserted by `helpers/temp.ts`):
- `parsePorcelainStatus`: staged/unstaged/untracked/renamed/conflict codes, detached-HEAD, no-upstream.
- Stage/unstage/commit paths incl. `commits-that-need-first-add` sequencing, `NOTHING_TO_COMMIT`, `IDENTITY_MISSING` (temp repo with cleared config).
- Discard: tracked restore vs untracked deletion (and that a missing untracked path is a tolerant no-op).
- Push/pull against `makeTempRemoteAndClone` (local bare remote): first push sets upstream; pull fast-forwards; divergence → `DIVERGED`; dirty → `WORKING_TREE_DIRTY`; `NO_REMOTE` post-`clone`-removal.
- Branch checkout/create: dirty/busy guards, `%`-invalid names, duplicates, checkout of remote-only name refused.
- agentBusy helper: arranged via `seedProject`/`forceStory`-equivalent helpers and one active `workspaces` row.
- DELETE route (via `buildTestApp`): 404, idempotent replay, `PROJECT_BUSY` refusal named after the story, successful purge removes cascade children (assert enumerating all project-scoped tables), removes `workspaces` rows + directories under a temp data dir, **leaves the project folder and `.git` byte-identical** (hash before/after), works for a deleted-folder (`unavailable`) project, and writes one audit-purge line.
- Trigger integrity: append-only triggers refuse direct DELETEs again after the purge transaction (post-purge SELECT over `sqlite_master`).

**E2E (Playwright, temp `AIK_DATA_DIR`):** register a temp-repo project → Git tab: stage → commit → push against a local bare remote (branch dropdown includes it) → delete project via the two dialogs → folder intact, gone from dashboard/sidebar/DB.

**Gates (AGENTS.md):** `npm run check:pins && npm run lint && npm run typecheck && npm test` green before any completion claim.

---

## 8. Alternatives considered

| Alternative | Verdict and reason |
|---|---|
| Wire the panel onto `sync-service`/`publish-service` | Rejected: they target worktree/PR flows and a connected GitHub app, not the user's main checkout on arbitrary remotes |
| Read-only git panel (`Open in terminal` only) | Rejected: contradicts the user's "same as other IDEs" requirement and the approved mockup |
| Archive-first project removal | Rejected for v1 (user decision: detach-only) but explicitly per §15.4, `archived` stays a reserved status; a UI-only archive toggle can later ride on the existing enum without schema change |
| SSE git-change events | Deferred: 5 s polling + action-triggered refetch is sufficient for a local-only panel |
| MXC isolation or new process containment for git operations | Not applicable: git view runs short-lived `execFile` calls in the orchestrator process, same trust level as existing merge/publish |

---

## 9. Decisions log (user, 2026-10-24)

1. Include: **Delete project** and the **Git view** (branch/status/history/commit/push/pull). Add-project flow stays as-is (it already adopts existing git repos without touching them).
2. Delete = **detach only**; the on-disk folder is never touched; app-generated worktrees are removed. No archive mode, no "optionally delete folder" checkbox.
3. Git view = **"looks the same as other IDEs"** (VS Code-style source control), user-approved mockup **variant A**: two columns (Source Control left, History right) with the **branch dropdown** added (search, local ✓, agent-tagged branches, remotes, create-new-branch), plus the guard promises shown in the mockups (agent-busy pause banner, dirty-tree protection, confirm dialogs).

---

## 10. Definition of done (maps to §30)

- Every endpoint above exists with zod contracts, registered in `startOrchestrator()`, and is covered by the §7 tests including the interim-backup/trigger-safety path.
- Deleting a project never mutates anything outside the app data dir and the DB (test-proven).
- The Git tab is reachable for every `active` project, all guards demonstrably fire, and e2e passes headlessly.
- No new dependencies introduced; pins remain exact; the redaction suite still passes.
- `docs/superpowers/plans/` gets the implementation plan for this sub-project before code moves.
