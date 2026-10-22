# Implementation Plan: GitHub Base Sync, PR Publishing, Polling & SHA-Bound Merge (`GH-6`, `GH-7`, `GH-8`, `GH-9`)

- **Spec:** `docs/superpowers/specs/2026-10-22-github-pr-sync-merge-design.md`
- **Goal:** Deliver Sub-Project 3 of Phase 3 GitHub Integration to complete Milestone B (MVP).

---

## Task Breakdown

### Task 1: Contracts & DTOs
- **Files:** `packages/contracts/src/github.ts`, `packages/contracts/src/index.ts`
- **Details:**
  - Define `ChecksSummary`, `ReviewsSummary`, `PullRequestDTO`.
  - Define `PublishStoryRequest`, `OverrideRemoteReviewRequest`.
- **Verification:** `npm run typecheck` passes.

### Task 2: PR Body Evidence Generator (`GH-7` Evidence Requirement §14)
- **Files:** `apps/orchestrator/src/github/pr-evidence.ts`, `apps/orchestrator/test/pr-evidence.test.ts`
- **Details:**
  - Pure function generating GitHub markdown from DB records:
    - Story details (key, title, description).
    - Acceptance criteria checklist with `review_ac_results`.
    - Verification checks table with duration, status, commit SHA.
    - Review verdict summary and non-blocking findings.
    - Commit history list.
    - Generation footer with attempt count.
- **Verification:** Unit tests in `pr-evidence.test.ts`.

### Task 3: Base Sync Service (`GH-6`)
- **Files:** `apps/orchestrator/src/github/sync-service.ts`, `apps/orchestrator/test/github-sync.test.ts`
- **Details:**
  - Detect upstream base movement via `gitWithCredentials(['fetch', 'origin', baseBranch])`.
  - If upstream moved:
    - Sync merge `origin/<base>` into candidate using `git merge-tree`.
    - If conflict -> transition to `REWORK` (T12) or `BLOCKED(conflict)`.
    - If clean -> create synced candidate commit -> transition `candidate_head_changed` (T11 to `TESTING`).
    - If PR exists, push with `--force-with-lease`.
  - Log to `remote_sync_runs`.
- **Verification:** Integration tests in `test/github-sync.test.ts`.

### Task 4: PR Publishing Service (`GH-7`)
- **Files:** `apps/orchestrator/src/github/publish-service.ts`, `apps/orchestrator/test/github-publish.test.ts`
- **Details:**
  - Guard on `publish=on` and `merge_approvals(publish, sha)`.
  - Push story branch via `gitWithCredentials` with `--force-with-lease`.
  - Create/update PR via GitHub REST API `POST /repos/{owner}/{repo}/pulls`.
  - Insert/update `pull_requests` table.
  - Audit run in `remote_sync_runs`.
- **Verification:** Integration tests in `test/github-publish.test.ts`.

### Task 5: PR Poller & Head-Drift Detection (`GH-8`)
- **Files:** `apps/orchestrator/src/github/pr-poller.ts`, `apps/orchestrator/test/github-poll.test.ts`
- **Details:**
  - Poll GitHub API for PR status, check-runs, statuses, and reviews with ETags.
  - Detect head drift (`remote head !== candidateSha`) -> transition story to `TESTING` (T11).
  - Update `checksSummary` and `reviewsSummary` in `pull_requests`.
  - Gate merge when checks fail or `CHANGES_REQUESTED` present.
  - Handle `override_remote_review` approval recording.
- **Verification:** Integration tests in `test/github-poll.test.ts`.

### Task 6: Remote Merge Service (`GH-9`)
- **Files:** `apps/orchestrator/src/github/remote-merger.ts`, `apps/orchestrator/test/github-merge.test.ts`
- **Details:**
  - Guard on `publish=on`, `remoteMerge=on`, `merge_approvals(merge, sha)`.
  - Validate remote checks passed and no un-overridden change requests.
  - Execute `PUT /repos/{owner}/{repo}/pulls/{number}/merge` passing `{ sha: candidateSha }`.
  - Handle 200 (fetch merged commit, run post-merge verification, `merge_completed` -> `DONE`).
  - Handle 409 (conflict/head moved -> T11).
  - Handle 405 (unmergeable error display).
  - External merge detection: verify merged commit contains candidate.
- **Verification:** Integration tests in `test/github-merge.test.ts`.

### Task 7: Orchestrator Routes & StoryService Wiring
- **Files:**
  - `apps/orchestrator/src/api/routes/github.ts`
  - `apps/orchestrator/src/stories/service.ts`
  - `apps/orchestrator/src/app.ts`
- **Details:**
  - Wire `publish`, `sync-base`, `poll-pr`, `override-remote-review` endpoints.
  - Update `StoryService` to handle `approve_publish` and remote `approve_merge`.
- **Verification:** Monorepo test suite passes.

### Task 8: UI Integration
- **Files:**
  - `apps/ui/src/components/github/pull-request-card.tsx`
  - `apps/ui/src/components/story/story-detail-modal.tsx` (or story details view)
  - `apps/ui/src/routes/board.tsx`
- **Details:**
  - Display PR link, state badge, checks indicator, review status.
  - "Publish PR" button in `AWAITING_MERGE`.
  - "Send to rework" and "Override Review" buttons when appropriate.
  - "Merge PR" button when remote merge is enabled.
- **Verification:** UI build and lint check.

### Task 9: Final Monorepo Verification
- **Command:** `npm run check:pins && npm run lint && npm run typecheck && npm test`
- **Details:** Full pass with zero warnings/errors.
