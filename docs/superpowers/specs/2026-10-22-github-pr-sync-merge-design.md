# GitHub Base Sync, PR Publishing, Polling & SHA-Bound Merge Design (`GH-6`, `GH-7`, `GH-8`, `GH-9`)

## 1. Overview & Context

This design implements Sub-Project 3 of Phase 3 GitHub Integration, achieving **Milestone B (MVP)** in the master design specification (`docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §14, §15, §16).

Stories covered:
- **`GH-6`**: Fetch and base sync for GitHub projects.
- **`GH-7`**: Publish PR with DB-evidence-generated body and `--force-with-lease` pushing.
- **`GH-8`**: PR status polling (ETags), check-runs / status aggregation, GitHub reviews, and head-drift detection.
- **`GH-9`**: SHA-bound remote merge (`PUT /repos/{o}/{r}/pulls/{n}/merge`), 405/409 handling, external merge verification, post-merge checks, and DONE completion.

---

## 2. Architecture & Service Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                                  UI                                    │
│  - Story Details & Board Card PR Status Badge                          │
│  - Publish PR Action Button (AWAITING_MERGE)                           │
│  - GitHub Checks & Review Status Panel                                 │
│  - Send to Rework / Override Remote Review Modals                      │
│  - SHA-Bound Remote Merge Button                                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP API
┌───────────────────────────────────▼────────────────────────────────────┐
│                              Orchestrator                              │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Story & GitHub Routes:                                           │  │
│  │   POST /stories/:id/publish                                      │  │
│  │   POST /stories/:id/transition (approve_publish, approve_merge)  │  │
│  │   POST /stories/:id/override-remote-review                       │  │
│  │   POST /stories/:id/sync-base                                    │  │
│  │   GET  /stories/:id/pr-status                                    │  │
│  │   POST /github/poll-prs (manual or 60s background timer)         │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│  ┌──────────────────────────────────▼───────────────────────────────┐  │
│  │ GitHubSyncService (GH-6):                                        │  │
│  │  - Fetches origin/<base> via gitWithCredentials                  │  │
│  │  - Checks base-moved ref; sync-merges origin/<base> into branch  │  │
│  │  - Conflict -> REWORK / BLOCKED(conflict)                        │  │
│  │  - Clean -> candidate_head_changed -> TESTING (T11)              │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│  ┌──────────────────────────────────▼───────────────────────────────┐  │
│  │ GitHubPublishService (GH-7):                                     │  │
│  │  - Verifies publish=on & merge_approvals(publish, sha)           │  │
│  │  - Generates PR body strictly from DB evidence (§14)             │  │
│  │  - Pushes branch via gitWithCredentials (--force-with-lease)      │  │
│  │  - Creates/updates PR via POST/PATCH /repos/{o}/{r}/pulls        │  │
│  │  - Records in pull_requests and remote_sync_runs                 │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│  ┌──────────────────────────────────▼───────────────────────────────┐  │
│  │ GitHubPRPoller (GH-8):                                           │  │
│  │  - Polls PR, check-runs, statuses, reviews with ETags (304 safe) │  │
│  │  - Updates checksSummary & reviewsSummary                        │  │
│  │  - Head-drift: remote head != candidateSha -> TESTING (T11)      │  │
│  │  - Failing checks disable merge; CHANGES_REQUESTED review gate   │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│  ┌──────────────────────────────────▼───────────────────────────────┐  │
│  │ GitHubMergeService (GH-9):                                       │  │
│  │  - Validates merge_approvals(merge, sha)                         │  │
│  │  - Synchronous PUT /repos/{o}/{r}/pulls/{n}/merge passing sha    │  │
│  │  - 409 -> head changed -> T11; 405 -> unmergeable reason         │  │
│  │  - Success -> fetch origin/<base> -> post-merge checks -> DONE   │  │
│  │  - External merge detection: verifies merged commit contains sha │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow & State Machine Transitions

### 3.1 Base Sync (`GH-6`)
1. Before worktree creation and before merge, orchestrator fetches `origin/<base>`.
2. If `origin/<base>` is not an ancestor of `story.candidateSha`:
   - Attempt `git merge-tree --write-tree origin/<base> candidateSha`.
   - If conflict:
     - Transition `merge_conflict` -> `REWORK` (T12) if attempts remain, or `fail` -> `BLOCKED('conflict')`.
   - If clean merge:
     - Create commit on story branch combining `origin/<base>` and `candidateSha`.
     - Transition `candidate_head_changed` -> `AWAITING_MERGE -> TESTING` (T11) with the new candidate SHA.
     - If PR already exists, push updated candidate using `--force-with-lease`.

### 3.2 PR Publishing (`GH-7`)
1. Pre-flight checks:
   - `story.status === 'AWAITING_MERGE'`.
   - `project.settings.publish === true`.
   - Human approval row exists in `merge_approvals` with `kind = 'publish'` and `commit_sha = story.candidateSha`.
2. Push branch:
   - Branch: `story.branchName` (e.g. `ai/INV-12-add-login`).
   - If new branch: `git push -u origin <branchName>` via `gitWithCredentials`.
   - If updating existing branch: `git push --force-with-lease=refs/heads/<branchName>:<lastKnownRemoteSha> origin <branchName>`.
   - If push rejected due to lease failure -> head drift (remote has unknown commits).
3. Generate PR body strictly from DB tables:
   - Header: `## Story: ${story.key} — ${story.title}\n\n${story.description}`.
   - Acceptance Criteria: table or checklist with criteria text, status (`met`/`unmet`), and evidence note from `review_ac_results`.
   - Verification Table: check name, status (`passed`), duration, commit SHA from `verification_checks`.
   - Review Findings: verdict (`APPROVED`), summary, blocking findings (0), non-blocking findings from `reviews` and `review_findings`.
   - Commits: list of commits between base and candidate.
   - Footer: `*Generated by AI Kanban (Attempt ${story.attemptCount})*`.
4. Call GitHub API:
   - `POST /repos/{owner}/{repo}/pulls` with `{ title: "${story.key}: ${story.title}", head: branchName, base: project.baseBranch, body }`.
   - Insert into `pull_requests` table.
   - Audit in `remote_sync_runs`.

### 3.3 Polling & Head-Drift (`GH-8`)
1. Poller queries open PRs in `pull_requests` where parent story is in `AWAITING_MERGE`.
2. Fetch PR details with `If-None-Match: etag`:
   - If `304 Not Modified`, checks and reviews are skipped unless cache TTL expired.
3. Fetch check runs: `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` (`filter=latest`).
4. Fetch commit status: `GET /repos/{owner}/{repo}/commits/{head_sha}/status`.
5. Fetch reviews: `GET /repos/{owner}/{repo}/pulls/{number}/reviews`.
6. State evaluations:
   - **Head Drift:** If `pr.head.sha !== story.candidateSha`:
     - Transition story: `candidate_head_changed` with `{ newSha: pr.head.sha, newTree: ... }` -> `TESTING` (T11).
   - **External Merge:** If `pr.state === 'closed'` and `pr.merged_at !== null`:
     - Run external merge flow (verify ancestor containment).
   - **Checks / Reviews summary update:** Store in `pull_requests.checksSummary` and `pull_requests.reviewsSummary`.
   - **Changes Requested:** If review summary has `CHANGES_REQUESTED`:
     - Disable merge.
     - Allow human `request_changes` (T12 to REWORK) or `override_remote_review` (`merge_approvals(override_remote_review)`).

### 3.4 SHA-Bound Remote Merge (`GH-9`)
1. Pre-flight checks:
   - `story.status === 'AWAITING_MERGE'`.
   - `project.settings.publish === true` and `project.settings.remoteMerge === true`.
   - Human approval in `merge_approvals` with `kind = 'merge'` and `commit_sha = story.candidateSha`.
   - Remote checks green (if `requireRemoteChecks === true`).
   - No un-overridden `CHANGES_REQUESTED` review.
2. Record `merges` row with `status = 'running'`, `approvedSha = story.candidateSha`, `method = 'github_merge' | 'github_squash'`.
3. Call `PUT /repos/{owner}/{repo}/pulls/{number}/merge`:
   - Body: `{ sha: story.candidateSha, merge_method: method }`.
4. Response handling:
   - `200 OK`:
     - Extract `mergedSha = data.sha`.
     - Update `merges` row (`status = 'succeeded'`, `mergedSha`).
     - Update `pull_requests` row (`state = 'merged'`, `mergeCommitSha = mergedSha`).
     - Fetch `origin/<base>` to update local base branch.
     - Run `verificationRunner.verifyPostMerge({ storyId, mergedSha })`.
     - If post-merge checks fail -> transition story to `BLOCKED('post_merge_failed')`.
     - If post-merge checks pass -> transition story via `merge_completed` (`actor = 'system'`) -> `DONE` (T10).
   - `409 Conflict`:
     - Remote head moved or merge conflict.
     - Update `merges` row to `failed`.
     - Trigger head-drift -> `AWAITING_MERGE -> TESTING` (T11).
   - `405 Method Not Allowed`:
     - Base branch protected or required reviews missing.
     - Update `merges` row to `failed` with error reason. Story stays in `AWAITING_MERGE`.

---

## 4. Contracts & API Endpoints

### 4.1 New Contracts in `@aik/contracts`
- `PullRequestDTO`:
  - `id`: number
  - `storyId`: number
  - `number`: number
  - `url`: string
  - `headBranch`: string
  - `headSha`: string
  - `baseBranch`: string
  - `state`: 'open' | 'closed' | 'merged'
  - `checksSummary`: `{ total: number; passed: number; failed: number; pending: number; checks: Array<{ name: string; status: string; conclusion: string | null; url: string | null }> }`
  - `reviewsSummary`: `{ state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'NONE'; latestReviewers: Array<{ user: string; state: string; body?: string }> }`
  - `mergeCommitSha`: string | null
  - `lastPolledAt`: number | null
- `PublishStoryRequest`:
  - `expectedVersion`: number
- `OverrideRemoteReviewRequest`:
  - `expectedVersion`: number
  - `note`: string

### 4.2 Routes in `apps/orchestrator`
- `POST /stories/:id/publish`
- `POST /stories/:id/sync-base`
- `GET /stories/:id/pr`
- `POST /stories/:id/poll-pr`
- `POST /stories/:id/override-remote-review`
- Transition handler additions in `StoryService` for `approve_publish` and GitHub-aware `approve_merge`.

---

## 5. Verification Plan
- Unit & integration tests in `apps/orchestrator/test/`:
  - `github-sync.test.ts`: base-moved detection, sync merge, clean candidate advance, conflict handling.
  - `github-publish.test.ts`: DB evidence body generation, permission checks, git push via credential helper, PR creation.
  - `github-poll.test.ts`: 304 ETag caching, head drift detection to TESTING (T11), checks and review summary aggregation.
  - `github-merge.test.ts`: SHA-bound merge call, 405/409 handling, post-merge checks, transition to DONE.
- Monorepo gate: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
