# Merge Integrity Cycle: SHA-bound approval, real post-merge evidence, safe cleanup

> Scope: close the highest-severity requirements gap found in the Phase 2 review. This plan
> supplements, but does not replace, `2026-10-18-phase-2-autonomous-execution.md`.

## Goal

Make the local merge path spec-compliant and fail-safe:

- A merge approval is created only by a human `approve_merge` request for the exact current
  candidate SHA and the loaded `statusVersion`.
- The merge job is retryable, lease-safe, and cannot merge a candidate that differs from the
  approval payload.
- The base branch is advanced with a CAS/ff-only update; dirty checkouts are refused.
- Conflicts move the story to REWORK, or BLOCKED(`conflict`) when attempts are exhausted.
- Post-merge mandatory checks run at the exact merged SHA in a fresh detached worktree and the
  T10 snapshot verifies that mandatory evidence actually passed.
- Cleanup removes a story worktree only when it is clean. Review and post-merge worktrees are
  always removed because they are detached and contain no unique work.
- The UI sends `expectedVersion`, an idempotency key, and refreshes the board after approval.

## Non-goals

- GitHub publishing/remote merge flows (`publish`, `remote_merge`).
- Changing the project-level `mergeMethod` semantics.
- Reorganising worktree paths under a `projectId` directory (existing path contract retained).
- Adding new dependencies or broad refactors outside the merge/verification path.

## Authoritative requirements

- Spec §13.5 steps 1–4 (base currency, tree-less merge, CAS/ff-only, post-merge checks).
- Spec §13.6 cleanup table (never force a story worktree; detached worktrees always removed).
- Spec §6.10 failure table (base sync conflict → REWORK/BLOCKED(conflict); dirty base → refuse;
  post-merge failure → BLOCKED(`post_merge_failed`)).
- Spec §16 T10 and invariant I1 (`DONE` requires approval, successful merge, merged SHA contains
  the candidate, and passed post-merge verification on `merged_sha`).
- Spec §21 S8 (unsafe merges), S7 (approval binding).

## Assumptions (Joe)

- `ProjectSettings.mergeMethod` is authoritative; `approve_merge.method` is accepted by the
  contract but does not override project settings.
- A repeated approval with the same API idempotency key is a duplicate request. A repeated
  approval with a new key is a retry and may enqueue a new job only when no merge job for the
  story is currently queued/leased.
- Post-merge checks run inside the merge job so the evidence and T10 transition are atomic from
  the user's perspective.
- For squash merges, "contains the candidate" is proven by the merger's tree equality check; for
  merge commits, additionally by ancestry. The merge row's `succeeded` status is written only
  after that proof.

## Shared contract

`durable_jobs.payload` for `kind='merge'`:

```ts
{ sha: string; approvalId: number }
```

The runner treats a job as stale (and completes it without merging) when `payload.sha` is not the
story's current candidate or when the referenced approval row does not exist.

## File ownership

| Workstream | Owned files |
|---|---|
| A. Approval request guards | `apps/orchestrator/src/stories/service.ts`, `apps/orchestrator/test/merge-approval.test.ts` |
| B. Worktree cleanup | `apps/orchestrator/src/git/worktree.ts`, `apps/orchestrator/test/worktree.test.ts` |
| C. Merger integrity | `apps/orchestrator/src/git/merger.ts`, `apps/orchestrator/test/merger.test.ts` |
| D. Verification evidence | `apps/orchestrator/src/verify/runner.ts`, `apps/orchestrator/test/verification.test.ts`, `apps/orchestrator/test/verifier.test.ts` |
| E. Runner lease/payload | `apps/orchestrator/src/agents/runner.ts`, `apps/orchestrator/test/runner.test.ts` |
| F. UI approval | `apps/ui/src/components/kanban/terminal-modal.tsx`, `apps/ui/src/components/kanban/board.tsx` |
| Lead integration | `apps/orchestrator/src/workflow/snapshot.ts`, plan/report artifacts, cross-cutting fixes |

No workstream may edit another workstream's files. Re-read every file immediately before editing
and preserve unrelated uncommitted changes.

## Acceptance criteria

1. `approve_merge` rejects a stale `expectedVersion`, a non-candidate SHA, a non-AWAITING_MERGE
   story, and an unavailable merge/queue dependency; it records exactly one approval row and one
   queued merge job per effective request.
2. Re-approving after a failed merge enqueues a fresh job; repeating the same request does not.
3. The merge job carries `{sha, approvalId}`; a stale payload completes without merging.
4. A long merge keeps its lease alive via heartbeat and refuses to transition when the lease was
   lost.
5. A merge conflict transitions AWAITING_MERGE → REWORK (or BLOCKED(`conflict`) with no attempts).
6. Post-merge verification records a `postmerge` run at `merged_sha` with mandatory check rows and
   passed status; T10 sees `false` if mandatory rows are missing or any mandatory row failed.
7. A mutation of the post-merge worktree HEAD during checks invalidates the run (no false pass).
8. A dirty story worktree is never force-removed; a clean one is removed and the branch deleted
   only when merged.
9. The UI approval request includes the story's `statusVersion`, uses the shared API client
   (idempotency key), shows the server's guard reason on failure, and refreshes the board after
   success.
10. `npm run check:pins && npm run lint && npm run typecheck && npm test` passes, with any
    pre-existing failures reported separately.

## Risks / migration

- No schema migration is required. Merge evidence is derived from existing immutable rows plus the
  merger's tree/ancestry checks.
- Renaming the detached post-merge directory suffix to `.post` matches the spec; stale `.postmerge`
  directories from earlier builds are not deleted automatically.
- A dirty story worktree left after DONE is intentional (never destroy user work) and is surfaced by
  the cleanup result for a later explicit Discard action.

---

## Cycle outcome (2026-10-19, executed)

**Implemented by six parallel workstreams** (approval guards, worktree cleanup, merger integrity,
verification evidence, runner lease/payload fencing, UI approval) plus lead integration
(T10 snapshot evidence, base-sync lease gate, review-fix batch).

**Verification:** `npm run check:pins && npm run lint && npm run typecheck && npm test` — all green;
48 test files, 521 tests passed (baseline at cycle start: 455/456 with one pre-existing red
`worktree.test.ts` dirty-preserve failure, now fixed).

**Independent QA verdict:** all 9 acceptance criteria PASS with file:line evidence; no integrity
hole found ("could not construct a path where the base advances without a SHA-bound human approval,
or where DONE is reached without real, mandatory, HEAD-validated post-merge evidence").
**Independent BA verdict:** APPROVE-WITH-NOTES; §13.5/§13.6/§16 T10+I1/§21 S7 traced COVERED.

**Post-review fixes applied (lead):**

1. Lease-expiry liveness: a `leased` merge job with a dead lease no longer blocks re-approval
   (`stories/service.ts`) and no longer sets `mergeInProgress` in the snapshot, so cancel/stop/
   request_changes stay available (`workflow/snapshot.ts`); regression test added.
2. `VERSION_CONFLICT` in the approval modal now actually refreshes the board before toasting.
3. Merger takes a `redact` dep (wired in `app.ts`); all persisted git output snippets
   (`merges.error`, merge-tree details) go through it.
4. Snapshot considers the newest post-merge run whatever its status, so a later failed run at the
   same SHA cannot be masked by an older passed one.
5. `testTimeout` raised to 60s for the git-heavy integration suites (was flaky at 5–20s on the
   target hardware).

**Known residuals / follow-ups (not blockers):**

- [x] Spec §13.5.4/§6.10 "offered revert commit after BLOCKED(post_merge_failed)" implemented across `LocalMerger.revertFailedMerge`, `StoryService.revertMerge`, `POST /stories/:id/revert-merge`, and Kanban card/modal UI.
- Untested branches: CAS `update-ref` path (base not checked out anywhere) and the squash
  `mergeMethod` variant.
- No UI unit-test harness exists; the approval and revert dialogs are covered by typecheck + server-side
  guard tests.
- Worktree paths are not `<projectId>`-namespaced (spec §13.1 vs plan non-goal); stale `.postmerge`
  directories from earlier builds are not swept.
- Cross-process races (a second orchestrator instance, external base moves mid-merge) are out of
  scope for this single-user desktop app.

**Next highest-value task:** `EXE-7` plan feedback and validation hardening or `EXE-18` setup wizard/diagnostics.

