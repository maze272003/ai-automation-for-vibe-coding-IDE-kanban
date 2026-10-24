# Phase 4 Completion (REL-4 … REL-8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining Reliability and Isolation stories (REL-4 … REL-8) to reach the Phase 4 exit criteria: clean-room detached verification, usage & quota metrics dashboard, unsigned per-user NSIS packaging with Electron fuses and ASAR integrity, retention pruning and secret-free diagnostics export, and the OpenCode contract upgrade gate.

**Architecture:**
- **REL-4:** `WorktreeManager.ensureCleanroomWorktree()` creates a clean detached worktree at the candidate SHA; `installCleanDependencies()` runs an isolated lockfile-bound install; `VerificationRunner` executes mandatory checks and records `trigger: 'cleanroom'`.
- **REL-5:** `UsageMetricsService` aggregates queries against `model_usage` grouped by provider and model (requests, input/output tokens, latency, failure/fallback rates, quota reset ETA). Exposed via `GET /api/metrics/usage`. UI dashboard rendered in `apps/ui`.
- **REL-6:** Electron-builder configuration in `apps/desktop/package.json` packages a per-user NSIS installer (`perMachine: false`) with hardened Electron fuses (`RunAsNode: false`, ASAR integrity enabled, cookie encryption enabled).
- **REL-7:** `RetentionService` prunes ephemeral worktrees, old agent run messages, and check logs past the retention window while preserving immutable audit rows. `DiagnosticsExportService` generates a secret-scrubbed export verified by `scanText`.
- **REL-8:** `scripts/opencode-upgrade-gate.ts` compares vendored and target OpenCode OpenAPI schemas, reports diffs, and gates version bumps on contract test execution.

**Tech Stack:** Node 24.17+, TypeScript 6.0.3, Fastify, Drizzle ORM, better-sqlite3, Electron 44.9, electron-builder, Vitest 5, React/Tailwind/Aurora tokens.

**Spec References:**
- Parent Spec: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §14.5, §15.4, §21.4, §24.2, §26.2 (REL-1…REL-8).
- Phase 4 Design Spec: `docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md`.

## Global Constraints
- Exact dependencies only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly.
- Code under `spikes/` is throwaway; never import it from `apps/` or `packages/`.
- Agents must run strictly unprivileged as the current user; never require administrator privileges.

---

### Task 1: REL-4 Clean-Room Verification

**Files:**
- Modify: `packages/contracts/src/projects.ts`
- Modify: `apps/orchestrator/src/git/worktree.ts`
- Modify: `apps/orchestrator/src/verify/runner.ts`
- Create: `apps/orchestrator/src/verify/cleanroom.ts`
- Create: `apps/orchestrator/test/cleanroom-verification.test.ts`

**Interfaces:**
- `ProjectSettings.cleanroomVerification`: boolean flag (default `false`).
- `ensureCleanroomWorktree({ repoPath, storyKey, candidateSha, storyId })`: returns clean detached worktree path.
- `installCleanDependencies(worktreePath, isolationRunner)`: runs `npm ci` or detected lockfile clean-install command in isolation.
- `VerificationRunner.verifyStory`: executes clean-room verification in fresh detached worktree when `settings.cleanroomVerification === true`, writing `verificationRuns` with `trigger: 'cleanroom'`.

- [ ] **Step 1: Write unit tests in `apps/orchestrator/test/cleanroom-verification.test.ts`**
  - Test clean-room worktree creation at detached candidate SHA.
  - Test clean dependency installation detecting lockfile (`package-lock.json` -> `npm ci`).
  - Test verification fails when candidate depends on uncommitted/dirty local `node_modules` drift.
  - Test verification passes and records `verificationRuns` with `trigger: 'cleanroom'` when cleanroom is enabled.

- [ ] **Step 2: Run test to observe failure**
  - Run: `npx vitest run apps/orchestrator/test/cleanroom-verification.test.ts`
  - Expected: FAIL (modules or methods not found).

- [ ] **Step 3: Update `ProjectSettings` schema**
  - Add `cleanroomVerification: z.boolean().default(false)` in `packages/contracts/src/projects.ts`.

- [ ] **Step 4: Implement clean-room worktree & dependency installer**
  - In `apps/orchestrator/src/git/worktree.ts`: implement `ensureCleanroomWorktree` and `removeCleanroomWorktree`.
  - In `apps/orchestrator/src/verify/cleanroom.ts`: implement `installCleanDependencies`.

- [ ] **Step 5: Wire clean-room verification into `VerificationRunner`**
  - In `apps/orchestrator/src/verify/runner.ts`: if `settings.cleanroomVerification` is true, create clean-room worktree, install clean dependencies, run checks, and record evidence with `trigger: 'cleanroom'`.

- [ ] **Step 6: Run clean-room tests to verify they pass**
  - Run: `npx vitest run apps/orchestrator/test/cleanroom-verification.test.ts`
  - Expected: PASS.

- [ ] **Step 7: Commit Task 1**
  ```bash
  git add packages/contracts/src/projects.ts apps/orchestrator/src/git/worktree.ts apps/orchestrator/src/verify apps/orchestrator/test/cleanroom-verification.test.ts
  git commit -m "feat(orchestrator): implement clean-room verification in detached worktrees (REL-4)"
  ```

---

### Task 2: REL-5 Usage & Quota Dashboard (Backend Service & API)

**Files:**
- Create: `apps/orchestrator/src/metrics/usage-service.ts`
- Modify: `apps/orchestrator/src/server.ts`
- Create: `apps/orchestrator/test/usage-metrics.test.ts`

**Interfaces:**
- `UsageMetricsService.getUsageSummary({ projectId, from, to })`: aggregates `model_usage` rows.
  - Returns: total requests, prompt tokens, completion tokens, average latency, failure count, fallback count, breakdown by provider and model profile, quota remaining and reset ETA.
- `GET /api/metrics/usage`: Fastify endpoint returning `UsageSummaryDTO`.

- [ ] **Step 1: Write unit tests in `apps/orchestrator/test/usage-metrics.test.ts`**
  - Test aggregation of tokens, requests, and latency across multiple model profiles.
  - Test filtering by date range and project.
  - Test fallback counting and error rate calculation.
  - Test security assertion: no prompt or completion text is ever returned or stored in metrics.

- [ ] **Step 2: Run test to observe failure**
  - Run: `npx vitest run apps/orchestrator/test/usage-metrics.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement `UsageMetricsService`**
  - Query `model_usage` joined with `modelProfiles` using Drizzle ORM.
  - Compute total and per-model aggregates, failure percentages, and quota status.

- [ ] **Step 4: Register API endpoint in `apps/orchestrator/src/server.ts`**
  - Add `GET /api/metrics/usage` route with query parameters validation (`projectId`, `since`).

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run apps/orchestrator/test/usage-metrics.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit Task 2**
  ```bash
  git add apps/orchestrator/src/metrics apps/orchestrator/src/server.ts apps/orchestrator/test/usage-metrics.test.ts
  git commit -m "feat(orchestrator): implement usage and quota metrics service and API (REL-5)"
  ```

---

### Task 3: REL-5 Usage & Quota Dashboard (UI View)

**Files:**
- Create: `apps/ui/src/components/UsageDashboard.tsx`
- Modify: `apps/ui/src/App.tsx`
- Create: `apps/ui/test/usage-dashboard.test.ts`

**Interfaces:**
- `UsageDashboard`: displays cards for total requests, token volume (input/output), avg latency, error rate, model distribution chart/list, and quota reset indicator.

- [ ] **Step 1: Write UI component tests in `apps/ui/test/usage-dashboard.test.ts`**
  - Test formatting of tokens (e.g. `1.2M`, `450k`) and latency (`240ms`).
  - Test calculation of quota countdown display.
  - Test rendering of empty state when no usage records exist.

- [ ] **Step 2: Run UI test to observe failure**
  - Run: `npx vitest run apps/ui/test/usage-dashboard.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement `UsageDashboard.tsx`**
  - Use Aurora palette tokens and vanilla CSS / design utilities.
  - Render summary metric stat cards and provider/model breakdown table.

- [ ] **Step 4: Integrate into `App.tsx` header navigation**
  - Add "Usage" button/modal or tab allowing users to open the usage dashboard.

- [ ] **Step 5: Run UI test to verify it passes**
  - Run: `npx vitest run apps/ui/test/usage-dashboard.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit Task 3**
  ```bash
  git add apps/ui/src apps/ui/test/usage-dashboard.test.ts
  git commit -m "feat(ui): implement usage and quota dashboard view (REL-5)"
  ```

---

### Task 4: REL-7 Retention Pruning & Diagnostics Export

**Files:**
- Create: `apps/orchestrator/src/maintenance/retention.ts`
- Create: `apps/orchestrator/src/maintenance/diagnostics.ts`
- Modify: `apps/orchestrator/src/server.ts`
- Create: `apps/orchestrator/test/retention-diagnostics.test.ts`

**Interfaces:**
- `RetentionService.prune({ maxAgeDays })`: deletes old check logs, ephemeral run messages, and completed temporary worktrees older than `maxAgeDays`.
  - Invariant: NEVER touches immutable tables (`reviews`, `review_findings`, `merges`, `story_events`).
- `DiagnosticsService.exportArchive()`: collects system diagnostics, redacted logs, project settings, and recent sync records.
  - Security invariant: Scanned with `scanText` to guarantee 0 secret leaks.
- Endpoints: `POST /api/maintenance/prune`, `GET /api/diagnostics/export`.

- [ ] **Step 1: Write tests in `apps/orchestrator/test/retention-diagnostics.test.ts`**
  - Test pruning removes old verification check logs and ephemeral messages while keeping `reviews` and `merges` intact.
  - Test diagnostics export produces a valid payload and contains no API keys or tokens (verified against `scanText`).

- [ ] **Step 2: Run test to observe failure**
  - Run: `npx vitest run apps/orchestrator/test/retention-diagnostics.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement `RetentionService`**
  - In `apps/orchestrator/src/maintenance/retention.ts`: implement prune logic respecting table immutability.

- [ ] **Step 4: Implement `DiagnosticsService`**
  - In `apps/orchestrator/src/maintenance/diagnostics.ts`: gather anonymized system stats, run redactor on logs, build export structure.

- [ ] **Step 5: Register routes in `apps/orchestrator/src/server.ts`**
  - Expose `/api/maintenance/prune` and `/api/diagnostics/export`.

- [ ] **Step 6: Run tests to verify they pass**
  - Run: `npx vitest run apps/orchestrator/test/retention-diagnostics.test.ts`
  - Expected: PASS.

- [ ] **Step 7: Commit Task 4**
  ```bash
  git add apps/orchestrator/src/maintenance apps/orchestrator/src/server.ts apps/orchestrator/test/retention-diagnostics.test.ts
  git commit -m "feat(orchestrator): implement retention pruning and secret-free diagnostics export (REL-7)"
  ```

---

### Task 5: REL-8 OpenCode Upgrade Contract-Suite Gate

**Files:**
- Create: `scripts/opencode-upgrade-gate.ts`
- Create: `scripts/test/opencode-upgrade-gate.test.ts`
- Modify: `package.json`

**Interfaces:**
- Script `scripts/opencode-upgrade-gate.ts`:
  - Compares target OpenCode OpenAPI spec against `packages/contracts/src/opencode.ts`.
  - Detects breaking removals or alterations in endpoints: `/session`, `/prompt`, `/event`, `/abort`.
  - Executes `packages/contracts/test/opencode.test.ts` against the candidate definition.
  - Outputs summary diff report.
  - Exits with 0 on full contract compatibility, 1 on breaking drift.
- NPM script: `npm run gate:opencode`.

- [ ] **Step 1: Write tests in `scripts/test/opencode-upgrade-gate.test.ts`**
  - Test contract gate passes on compatible API additions (new optional fields).
  - Test contract gate fails and outputs diff on breaking changes (removed endpoint, altered required field).

- [ ] **Step 2: Run test to observe failure**
  - Run: `npx vitest run scripts/test/opencode-upgrade-gate.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement `scripts/opencode-upgrade-gate.ts`**
  - Diff endpoints and parameters against vendored OpenAPI schema.
  - Run contracts test suite in child process.

- [ ] **Step 4: Add `gate:opencode` to root `package.json`**
  - `"gate:opencode": "node --experimental-strip-types scripts/opencode-upgrade-gate.ts"`.

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run scripts/test/opencode-upgrade-gate.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit Task 5**
  ```bash
  git add scripts/opencode-upgrade-gate.ts scripts/test/opencode-upgrade-gate.test.ts package.json
  git commit -m "feat(tooling): implement OpenCode upgrade contract-suite gate (REL-8)"
  ```

---

### Task 6: REL-6 Unsigned NSIS Installer & Electron Fuses

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/scripts/apply-fuses.mjs`
- Create: `apps/desktop/test/packaging-config.test.ts`
- Modify: `package.json`

**Interfaces:**
- Packaging config in `apps/desktop/package.json` specifying `nsis` target:
  - `perMachine: false` (per-user install into `%LOCALAPPDATA%\Programs\AiKanban`).
  - Does NOT require admin privileges.
  - Data directory preserved at `%LOCALAPPDATA%\AiKanban`.
- `apply-fuses.mjs`:
  - `RunAsNode: false`
  - `EnableCookieEncryption: true`
  - `EnableNodeOptionsEnvironmentVariable: false`
  - `EnableEmbeddedAsarIntegrityValidation: true`
- NPM script: `npm run package:verify`.

- [ ] **Step 1: Write tests in `apps/desktop/test/packaging-config.test.ts`**
  - Verify `electron-builder` configuration has `perMachine === false`.
  - Verify NSIS options specify unprivileged per-user installation.
  - Verify fuse definitions enforce `RunAsNode === false` and `EnableEmbeddedAsarIntegrityValidation === true`.
  - Verify included resources specify `aiide-helper.exe` and catalog assets.

- [ ] **Step 2: Run test to observe failure**
  - Run: `npx vitest run apps/desktop/test/packaging-config.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Configure packaging and fuses script**
  - In `apps/desktop/package.json`: define `build` field with `nsis` options and fuses config.
  - In `apps/desktop/scripts/apply-fuses.mjs`: configure `@electron/fuses` toggle script.

- [ ] **Step 4: Add `package:verify` script to root `package.json`**
  - Add helper script to validate packaging integrity without requiring full Windows code signing.

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run apps/desktop/test/packaging-config.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit Task 6**
  ```bash
  git add apps/desktop/package.json apps/desktop/scripts/apply-fuses.mjs apps/desktop/test/packaging-config.test.ts package.json
  git commit -m "feat(desktop): configure unsigned per-user NSIS installer and electron fuses (REL-6)"
  ```

---

### Task 7: Full Monorepo Verification & Phase 4 Sign-Off

**Files:**
- Modify: `docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md`
- Modify: `docs/superpowers/plans/2026-10-24-phase-4-completion-rel4-to-rel8.md`

- [ ] **Step 1: Update design spec with Phase 4 completion summary**
  - Document satisfaction of all 8 Phase 4 stories: REL-1 through REL-8.
  - Confirm exit criteria: MXC decision implemented (NO-GO) with Path B Job Object runner; unprivileged clean-room verification; usage dashboard; per-user installer; retention pruning; OpenCode upgrade gate.

- [ ] **Step 2: Run monorepo full verification gate**
  - Run: `npm run check:pins`
  - Run: `npm run lint`
  - Run: `npm run typecheck`
  - Run: `npm test`
  - Expected: All checks pass cleanly with 0 errors.

- [ ] **Step 3: Mark plan complete and commit final pass**
  ```bash
  git add docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md docs/superpowers/plans/2026-10-24-phase-4-completion-rel4-to-rel8.md
  git commit -m "docs: finalize Phase 4 (Reliability and Isolation) implementation and sign-off"
  ```
