# Phase 2: Autonomous Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform AI Kanban from a manual board into an autonomous AI development pipeline where newly created user stories are automatically claimed by OpenCode, planned, implemented in isolated Git worktrees, verified, and progressed through the Kanban stages with live visual feedback.

**Architecture:**
- The Orchestrator's `AgentRunner` manages durable background jobs (`plan`, `implement`, `verify`, `review`) from `JobQueue`.
- The `AgentRuntime` communicates with OpenCode via the local API client (connecting to the user's running OpenCode background service or isolated instance).
- For planning (`EXE-7`), OpenCode generates an architecture/implementation plan for the story in `NEW`, sets `planningStatus = 'plan_proposed'`, and transitions the story to `READY` upon approval or auto-accept.
- For implementation (`EXE-1`, `EXE-8`), the `WorktreeManager` creates an isolated Git worktree under `%LOCALAPPDATA%\AiKanban\wt\<storyKey>\`. OpenCode operates inside this worktree to implement the plan, after which candidate commits are captured and the story transitions to `TESTING`.
- All runs record live state in `agent_runs` and `user_stories.activeRunId`, driving the Kanban card's terminal working badge and real-time SSE stage transitions.

**Tech Stack:**
- Electron 44.9.0, Node ≥ 24.17.0, TypeScript 6.0.3, Fastify 5.12.7, Drizzle ORM 0.45.4, better-sqlite3 13.0.3, Vitest 5.0.5.

**Spec Reference:**
- `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §6, §13, §16, §18, §19, and stories `EXE-1`, `EXE-4`, `EXE-7`, `EXE-8`, `EXE-9`, `EXE-10`, `EXE-11`.

---

## File Structure

```
apps/orchestrator/src/
  agents/
    runtime.ts            # AgentRuntime interface and OpenCode client adapter (EXE-4)
    runner.ts             # Background job runner / dispatcher for plan, implement, verify, review & merge jobs
    planner.ts            # Planner agent prompt construction, execution & plan parsing (EXE-7)
    implementer.ts        # Implementer agent prompt construction, execution & candidate capture (EXE-8)
    reviewer.ts           # Independent reviewer, verdict normalization & immutable findings (EXE-11)
    verifier.ts           # Compatibility adapter over VerificationRunner
  checks/
    detect.ts             # Repository check detection and secrets-only acceptance (EXE-9)
    run.ts                # Argv-only check execution, scrubbed env, timeout & process-tree kill
  verify/
    runner.ts             # Candidate and post-merge verification evidence (EXE-10)
  secrets/
    scan.ts               # Mandatory secrets scan for tracked and staged content
  git/
    worktree.ts           # WorktreeManager: safe creation, isolation & cleanup of story worktrees (EXE-1)
    merger.ts             # Local merge pipeline and post-merge verification (EXE-14, EXE-15)
    protected.ts          # Protected-path glob matching
  app.ts                  # Wire AgentRunner into startOrchestrator lifecycle
packages/contracts/src/
  plans.ts                # PlanDTO and PlanProposal schemas
apps/ui/src/components/kanban/
  card.tsx                # Card with live terminal working badge and run metadata
```

---

### Task 1: OpenCode Agent Runtime & Session Client (`EXE-4`)

**Files:**
- Create: `apps/orchestrator/src/agents/runtime.ts`
- Create: `apps/orchestrator/test/agent-runtime.test.ts`

- [x] **Step 1: Write unit tests for `OpenCodeRuntime`**
  - Verify session creation with model selection.
  - Verify prompt dispatch and waiting for completion via `/api/session/active`.
  - Verify error handling and extraction of assistant response text.

- [x] **Step 2: Implement `OpenCodeRuntime` in `apps/orchestrator/src/agents/runtime.ts`**
  - Implement `createSession`, `sendPrompt`, and `pollCompletion`.
  - Support passing working directory (project root or worktree path).
  - Handle authentication using OpenCode server credentials.

- [x] **Step 3: Run tests & verify**
  - Run `npm test apps/orchestrator/test/agent-runtime.test.ts`.

---

### Task 2: Planner Agent & Automatic Story Planning (`EXE-7`)

**Files:**
- Create: `apps/orchestrator/src/agents/planner.ts`
- Modify: `apps/orchestrator/src/stories/service.ts`
- Create: `apps/orchestrator/test/planner.test.ts`

- [x] **Step 1: Write unit tests for `PlannerAgent`**
  - Test prompt construction incorporating story title, description, acceptance criteria, and project context.
  - Test plan parser (extracting tasks, affected files, and verification steps from OpenCode's response).
  - Test that creating a story in `NEW` enqueues a `plan` job.

- [x] **Step 2: Implement `PlannerAgent`**
  - Construct structured prompt requiring JSON/Markdown plan structure.
  - Persist generated plan to SQLite `plans` table.
  - Update `user_stories.planningStatus = 'plan_proposed'`.
  - Trigger `WorkflowService.transition({ event: { type: 'auto_accept_plan', planVersion } })` when auto-accept is enabled, advancing story `NEW` → `READY`.

- [x] **Step 3: Run tests & verify**
  - Run `npm test apps/orchestrator/test/planner.test.ts`.

---

### Task 3: Git Worktree Manager (`EXE-1`)

**Files:**
- Create: `apps/orchestrator/src/git/worktree.ts`
- Create: `apps/orchestrator/test/worktree.test.ts`

- [x] **Step 1: Write integration tests for `WorktreeManager` with temporary git repos**
  - Verify worktree creation on a dedicated story branch `story/<storyKey>`.
  - Verify realpath containment checks (preventing path traversal outside data directory).
  - Verify worktree removal and pruning.

- [x] **Step 2: Implement `WorktreeManager`**
  - Manage worktrees in `%LOCALAPPDATA%\AiKanban\wt\<storyKey>\`.
  - Track active workspaces in SQLite `workspaces` table.

- [x] **Step 3: Run tests & verify**
  - Run `npm test apps/orchestrator/test/worktree.test.ts`.

---

### Task 4: Implementer Agent & Candidate Commit Capture (`EXE-8`)

**Files:**
- Create: `apps/orchestrator/src/agents/implementer.ts`
- Create: `apps/orchestrator/test/implementer.test.ts`

- [x] **Step 1: Write integration tests for `ImplementerAgent`**
  - Test claiming a story in `READY` (transition `T3` → `IN_PROGRESS`).
  - Test running OpenCode inside the story worktree with the approved plan.
  - Test capturing git diff and committing candidate SHA with story trailers.
  - Test transitioning story from `IN_PROGRESS` → `TESTING` (`T4`).

- [x] **Step 2: Implement `ImplementerAgent`**
  - Construct prompt with task breakdown from approved plan.
  - Run OpenCode session inside worktree.
  - Capture modified files, create Git commit, record `candidate_sha` and `candidate_tree`.
  - Trigger transition `T4` to move story to `TESTING`.

- [x] **Step 3: Run tests & verify**
  - Run `npm test apps/orchestrator/test/implementer.test.ts`.

---

### Task 5: Orchestrator Background Worker Loop & Live UI Verification

**Files:**
- Create: `apps/orchestrator/src/agents/runner.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Modify: `apps/orchestrator/src/config.ts`

- [x] **Step 1: Implement `AgentRunner`**
  - Polls `JobQueue` for leased jobs (`plan`, `implement`).
  - Sets `user_stories.activeRunId` during execution (powering the Terminal Icon & pulsing dot on the Kanban card).
  - Emits real-time SSE updates as stages change.

- [x] **Step 2: Wire `AgentRunner` into `startOrchestrator`**
  - Initialize `AgentRunner` on startup and gracefully shut down on exit.

- [x] **Step 3: Full Verification**
  - Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
  - Verify in the running Electron app that adding a new user story automatically shows the terminal indicator and moves from `NEW` → `READY`.

---

## Continuation: verification, review and rework (EXE-9 … EXE-12)

The first slice stopped at `TESTING`. This slice closes the loop up to `AWAITING_MERGE`:
checks are proposed from the repository, mandatory checks run against the exact candidate, an
independent reviewer produces a SHA-bound verdict, and failures feed the next implementation attempt.

### Task 6: Check detection and secrets-only acceptance (`EXE-9`)

**Files:**
- Create: `apps/orchestrator/src/checks/detect.ts`
- Modify: `packages/contracts/src/projects.ts` (secrets-only acceptance flag)
- Create: `apps/orchestrator/test/check-detection.test.ts`

- [x] **Step 1:** Detect npm/pnpm/yarn (lockfile or `packageManager`) and Python (uv/poetry/pip) check commands from fixture repositories.
- [x] **Step 2:** Expose the proposal through `GET /projects/:id/checks/proposal`; nothing is persisted until the human PATCHes the project settings.
- [x] **Step 3:** Require `secretsOnlyVerification` for repositories without detectable checks.

### Task 7: Verification runner and evidence (`EXE-10`)

**Files:**
- Create: `apps/orchestrator/src/checks/run.ts`
- Create: `apps/orchestrator/src/verify/runner.ts`
- Create: `apps/orchestrator/test/verification.test.ts`

- [x] **Step 1:** Assert `HEAD == candidate` and a clean worktree; refuse to record evidence otherwise.
- [x] **Step 2:** Run mandatory checks without an API-invoked shell, with a scrubbed environment, timeout and process-tree kill; always run the internal secrets scan.
- [x] **Step 3:** Persist one row per check (command, timestamps, exit code, status, tail, log path, SHA) and emit T5 on success. `skipped`/`unsupported` never pass.

### Task 8: Reviewer and verdict normalization (`EXE-11`)

**Files:**
- Create: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/git/worktree.ts` (detached review worktree)
- Create: `apps/orchestrator/test/reviewer.test.ts`

- [x] **Step 1:** Review from a detached worktree at `candidate_sha`, read-only, and discard the review if `HEAD` moved or the tree is dirty.
- [x] **Step 2:** Validate `ReviewV1`, normalize APPROVED with blocking findings/unmet criteria/missing checklist entries to CHANGES_REQUESTED, and treat BLOCKED without a reason as invalid output.
- [x] **Step 3:** Persist reviews, findings, criterion results and prior-finding links immutably; fire T7, T8 or BLOCKED(`reviewer_blocked`/`invalid_agent_output`).
- [x] **Step 4:** Keep findings that cite files outside the diff/repo, but persist `location_verified = false` (spec §19.4 `unverified_location`); surface it as `unverifiedLocation` in `GET /stories/:id/details` and as a badge in the review tab.

### Task 9: Rework loop and no-progress detection (`EXE-12`)

**Files:**
- Modify: `apps/orchestrator/src/agents/implementer.ts`
- Modify: `apps/orchestrator/src/agents/runner.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Create: `apps/orchestrator/test/rework.test.ts`

- [x] **Step 1:** Enqueue `verify`, `review` and repair `implement` jobs from the story state (idempotent per candidate SHA/attempt).
- [x] **Step 2:** Feed failed check tails and blocking findings into the repair prompt; capture trailers, protected paths and reject identical candidate trees.
- [x] **Step 3:** Exhausted budgets go to BLOCKED(`retry_limit`), identical trees to BLOCKED(`no_progress`).
- [x] **Step 4:** Run the full gate: `npm run check:pins && npm run lint && npm run typecheck && npm test`.

---

### Task 10: Local Merge Pipeline & Worktree Cleanup (`EXE-14`, `EXE-15`)

**Files:**
- Create: `apps/orchestrator/src/git/merger.ts`
- Create: `apps/orchestrator/test/merger.test.ts`
- Modify: `apps/orchestrator/src/stories/service.ts`
- Modify: `apps/orchestrator/src/agents/runner.ts`

- [x] **Step 1: Write integration tests for `LocalMerger`**
  - Test recording `merge_approvals` on human approval.
  - Test performing local git merge into `baseBranch`.
  - Test running post-merge verification checks on `mergedSha`.
  - Test transitioning story to `DONE` (T10).
  - Test safe worktree removal and pruning.

- [x] **Step 2: Implement `LocalMerger`**
  - Implement merge execution, candidate containment check, post-merge checks, and cleanup.
  - Enable `approve_merge` in `StoryService`.
  - Wire into `AgentRunner` for `merge` job kind.
  - Approving again after a failed merge enqueues a fresh job (the key is bound to the approval request, not only the SHA).

- [x] **Step 3: Safe cleanup (spec §13.6)**
  - Story worktrees are removed only when clean, never with `--force`; dirty worktrees stay for investigation.
  - Branches are deleted only with `git branch -d` (already-merged).

- [x] **Step 4: Run tests & verify**
  - Run `npm test apps/orchestrator/test/merger.test.ts`.

---

### Task 11: Story Detail UI Tabs, Diff Viewer & Merge Approval (`EXE-16`, `EXE-17`)

**Files:**
- Modify: `apps/ui/src/components/kanban/terminal-modal.tsx`
- Modify: `apps/ui/src/components/kanban/card.tsx`
- Modify: `apps/ui/src/components/kanban/board.tsx`
- Modify: `apps/orchestrator/src/stories/service.ts`

- [x] **Step 1: Expose Story Details (Plan, Checks, Review, Diff) in API**
  - Add API endpoints to fetch plan details, verification runs, review findings, and git diff.

- [x] **Step 2: Build Rich Tabs in UI Modal**
  - Plan Tab: summary, subtasks, affected files, criteria.
  - Verification Tab: check runs, exit codes, output logs.
  - Review Tab: verdict badge, findings severity list, AC checklist.
  - Diff Tab: colored git diff for `baseSha..candidateSha`.
  - In `AWAITING_MERGE`: show prominent "Approve & Merge" button.

- [x] **Step 3: Full End-to-End Verification**
  - Run `npm run check:pins; npm run lint; npm run typecheck; npm test`.

