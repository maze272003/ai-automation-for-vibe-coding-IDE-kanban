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
    runner.ts             # Background job runner / dispatcher for plan & implement jobs
    planner.ts            # Planner agent prompt construction, execution & plan parsing (EXE-7)
    implementer.ts        # Implementer agent prompt construction, execution & candidate capture (EXE-8)
  git/
    worktree.ts           # WorktreeManager: safe creation, isolation & cleanup of story worktrees (EXE-1)
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
