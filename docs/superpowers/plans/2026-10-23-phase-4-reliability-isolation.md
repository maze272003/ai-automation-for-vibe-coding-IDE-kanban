# Phase 4 Sub-Project 4.1: REL-1 Isolation Spike & Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish OS-level process containment for agent execution (REL-1): evaluate Microsoft MXC `processcontainer` under an unprivileged user token in throwaway spike SPK-6, produce empirical evidence and escape audit in `docs/superpowers/spikes/SPK-6.md`, and build the `IsolationRunner` abstraction in the orchestrator with automatic adoption (if GO) or hardened Job Object fallback (if NO-GO).

**Architecture:**
- All evaluation code lives under `spikes/spk-6/` pinning `@microsoft/mxc-sdk@1.0.1` and is strictly throwaway.
- Probe harness `probe.mjs` verifies unprivileged container startup, worktree read-write, user profile/SSH denial, traversal blocking, Windows Credential Manager isolation, network egress blocking vs loopback gateway allowlist, and toolchain viability.
- The orchestrator introduces `IsolationRunner` (`apps/orchestrator/src/isolation/runner.ts`), consumed by `apps/orchestrator/src/checks/run.ts` and `apps/orchestrator/src/git/worktree.ts`.
- If SPK-6 is GO: `MxcIsolationRunner` executes checks and agent commands inside `processcontainer`.
- If SPK-6 is NO-GO: `JobObjectIsolationRunner` formalizes the hardened `aiide-helper.exe` containment with isolated scratch environments and secrets scanning.

**Tech Stack:**
- Node 24.17+, TypeScript 6.0.3, `@microsoft/mxc-sdk@1.0.1` (throwaway spike), Go (`spikes/spk-3/helper/aiide-helper.exe`), Fastify, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md`

## Global Constraints
- Dependencies use exact versions only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly.
- Code under `spikes/` is throwaway; never import it from `apps/` or `packages/`.
- Agents must run strictly unprivileged as the current user; never require administrator privileges or UAC elevation.

---

### Task 1: SPK-6 Spike Scaffolding & Package Pinning

**Files:**
- Create: `spikes/spk-6/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: Isolated spike directory `spikes/spk-6/` with `@microsoft/mxc-sdk@1.0.1` installed and verified without affecting root dependencies.

- [ ] **Step 1: Write `spikes/spk-6/package.json`**

```json
{
  "name": "aik-spk-6",
  "private": true,
  "type": "module",
  "dependencies": {
    "@microsoft/mxc-sdk": "1.0.1"
  }
}
```

- [ ] **Step 2: Ensure `.gitignore` covers spike node_modules and output**

Verify `.gitignore` contains `spikes/**/node_modules/` and `spikes/**/out/`. If not present, add them.

- [ ] **Step 3: Install the spike package**

Run: `npm install --prefix spikes/spk-6 --save-exact`
Expected: `spikes/spk-6/node_modules/@microsoft/mxc-sdk` exists and `package-lock.json` is generated.

- [ ] **Step 4: Verify package import**

Run: `node -e "import('@microsoft/mxc-sdk').then(m => console.log('MXC SDK load: OK')).catch(e => console.error(e))"` with `NODE_PATH=spikes/spk-6/node_modules` (or cwd `spikes/spk-6`).
Expected: prints `MXC SDK load: OK` or exact Win32 FFI initialization error.

- [ ] **Step 5: Commit scaffolding**

```bash
git add spikes/spk-6/package.json spikes/spk-6/package-lock.json .gitignore
git commit -m "spike(SPK-6): scaffold MXC isolation probe package"
```

---

### Task 2: Implement the SPK-6 Automated Escape & Feasibility Probe

**Files:**
- Create: `spikes/spk-6/probe.mjs`

**Interfaces:**
- Consumes: `@microsoft/mxc-sdk`
- Produces: `node spikes/spk-6/probe.mjs [--out=spikes/spk-6/out/results.json]`, outputting a structured JSON summary of all 6 probe test cases.

- [ ] **Step 1: Write `spikes/spk-6/probe.mjs`**

Write the complete probe script implementing:
- Probe 1: Unprivileged container creation check.
- Probe 2: Filesystem permissions (worktree write: allow; `%USERPROFILE%\.ssh` & `%USERPROFILE%\.config\opencode`: deny; traversal `..\..`: deny).
- Probe 3: Credential isolation (`cmdkey /list` and `CredReadW` cannot reach host credentials).
- Probe 4: Network egress deny (external socket fails, loopback to local gateway port succeeds).
- Probe 5: Toolchain validation (`git --version`, `node -v` run cleanly inside container).
- Probe 6: Cold/warm latency and memory benchmarking.

- [ ] **Step 2: Verify probe script syntax**

Run: `node --check spikes/spk-6/probe.mjs`
Expected: exits with code 0 (clean syntax).

- [ ] **Step 3: Commit probe script**

```bash
git add spikes/spk-6/probe.mjs
git commit -m "spike(SPK-6): implement automated escape and feasibility probe harness"
```

---

### Task 3: Execute SPK-6 and Produce Evidence Report (`SPK-6.md`)

**Files:**
- Create: `docs/superpowers/spikes/SPK-6.md`

**Interfaces:**
- Consumes: Execution results from `node spikes/spk-6/probe.mjs`.
- Produces: Comprehensive markdown report with evidence tables, [V] markers, and explicit **GO** or **NO-GO** verdict.

- [ ] **Step 1: Run the probe harness**

Run: `node spikes/spk-6/probe.mjs`
Expected: Output prints results for Probes 1 through 6, displaying PASS/FAIL and observed latency/memory.

- [ ] **Step 2: Write `docs/superpowers/spikes/SPK-6.md`**

Structure:
- Date, Executor, OS build (Windows 11 build 26200.9711), SDK version (`@microsoft/mxc-sdk@1.0.1`).
- Results table covering all 6 probes with exact observed outputs.
- Analysis: does MXC require admin rights on this system? Do escape checks hold?
- Architectural Verdict: **GO** (integrate MXC into orchestrator) or **NO-GO** (fall back to hardened Job Objects + promote ADV-2).

- [ ] **Step 3: Commit report**

```bash
git add docs/superpowers/spikes/SPK-6.md
git commit -m "docs(spikes): record SPK-6 MXC isolation probe findings and verdict"
```

---

### Task 4: Orchestrator `IsolationRunner` Abstraction

**Files:**
- Create: `apps/orchestrator/src/isolation/runner.ts`
- Create: `apps/orchestrator/src/isolation/job-object.ts`
- Create: `apps/orchestrator/src/isolation/mxc.ts` (if GO) or fallback stub
- Create: `apps/orchestrator/src/isolation/index.ts`
- Create: `apps/orchestrator/test/isolation-runner.test.ts`

**Interfaces:**
- Produces: `getIsolationRunner(options)` returning an implementation of `IsolationRunner`.

- [ ] **Step 1: Write unit tests in `apps/orchestrator/test/isolation-runner.test.ts`**
  - Test command execution in a temporary worktree.
  - Test stdio capture and exit code propagation.
  - Test timeout termination.
  - Test environment scrubbing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/isolation-runner.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `runner.ts`, `job-object.ts`, and `index.ts`**
  - Define `IsolationRunner`, `ProcessResult`, and `IsolationOptions`.
  - Implement `JobObjectIsolationRunner` wrapping `aiide-helper.exe` with redirected scratch environments.
  - Implement `MxcIsolationRunner` (if SPK-6 verdict is GO).
  - Implement factory in `index.ts` selecting the verified runner.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/isolation-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit `IsolationRunner`**

```bash
git add apps/orchestrator/src/isolation apps/orchestrator/test/isolation-runner.test.ts
git commit -m "feat(orchestrator): implement IsolationRunner abstraction"
```

---

### Task 5: Wire `IsolationRunner` into Check Execution and Worktree Management

**Files:**
- Modify: `apps/orchestrator/src/checks/run.ts`
- Modify: `apps/orchestrator/src/git/worktree.ts`
- Modify: `apps/orchestrator/test/verification.test.ts`

**Interfaces:**
- Consumes: `getIsolationRunner` from `apps/orchestrator/src/isolation/index.ts`.
- Ensures: All check runs and agent commands execute through the isolated runner.

- [ ] **Step 1: Update `apps/orchestrator/src/checks/run.ts`**
  - Replace direct process spawning with `isolationRunner.run()`.
  - Ensure scrubbed environment and worktree directory are passed.

- [ ] **Step 2: Update `apps/orchestrator/test/verification.test.ts`**
  - Verify that mandatory checks execute through the runner and produce expected exit codes and output logs.

- [ ] **Step 3: Run verification tests**

Run: `npx vitest run apps/orchestrator/test/verification.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit integration changes**

```bash
git add apps/orchestrator/src/checks/run.ts apps/orchestrator/src/git/worktree.ts apps/orchestrator/test/verification.test.ts
git commit -m "feat(orchestrator): wire check execution through IsolationRunner"
```

---

### Task 6: Full Verification Gate & Phase 4 Spec Update

**Files:**
- Modify: `docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md`

- [ ] **Step 1: Update design spec with verdict and implementation outcomes**
  - Record the resolved SPK-6 verdict in §4 and §5.

- [ ] **Step 2: Run monorepo full verification suite**
  - Run: `npm run check:pins`
  - Run: `npm run lint`
  - Run: `npm run typecheck`
  - Run: `npm test`
  - Expected: All checks pass cleanly with 0 errors.

- [ ] **Step 3: Commit final pass**

```bash
git add docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md
git commit -m "docs: finalize Sub-Project 4.1 REL-1 isolation implementation"
```
