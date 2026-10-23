# Phase 4 Sub-Project 4.1: Reliability and Isolation Design Specification (REL-1)

| | |
|---|---|
| **Date** | 2026-10-23 |
| **Status** | Implemented & Verified: SPK-6 completed (NO-GO for unprivileged toolchain ACLs); Path B (`JobObjectIsolationRunner`) adopted |
| **Scope** | Phase 4 decomposition & Sub-Project 4.1: REL-1 Microsoft MXC isolation spike (SPK-6) and conditional orchestrator integration |
| **Parent Spec** | `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §21.4, §25.2, §26.1 (REL-1…REL-8) |

---

## 1. Executive Summary

Phase 4 ("Reliability and Isolation", P1) elevates AI Kanban from a functional prototype into a reliable, contained, and packageable developer desktop application. 

The approved roadmap (§25.2) defines 8 stories for Phase 4:
- **REL-1:** MXC isolation spike and integration (P1, XL)
- **REL-2:** Automatic rework on remote CI failure (P1, M)
- **REL-3:** `osv-scanner` dependency scanning (P1, S)
- **REL-4:** Clean-room verification in fresh detached worktrees (P1, M)
- **REL-5:** Usage and quota dashboard (P1, M)
- **REL-6:** Unsigned NSIS installer and install verification (P1, M)
- **REL-7:** Retention jobs and diagnostics export (P1, S)
- **REL-8:** OpenCode upgrade contract-suite gate (P1, M)

Because tackling all 8 stories simultaneously would produce a monolithic, unwieldy implementation plan, Phase 4 is decomposed into focused sub-projects. This specification establishes the architecture for Phase 4's primary security gate: **Sub-Project 4.1: REL-1 (MXC Isolation Spike SPK-6 & Orchestrator Integration)**.

---

## 2. Core Architecture & Constraints

### 2.1 Unprivileged User Constraint
**Mandatory Rule:** Agents must never require administrator privileges or UAC elevation.
- If Microsoft MXC (`@microsoft/mxc-sdk`) requires administrative privileges or fails the unprivileged escape suite on Windows 11 (build ≥ 26200.9278), the spike concludes **NO-GO**.
- A **NO-GO** outcome retains the verified Go Job Object runner ([`aiide-helper.exe`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/spikes/spk-3/helper/main.go)), strengthens environment scrubbing, and promotes `ADV-2` (separate low-privilege Windows user) in the roadmap.

### 2.2 Throwaway Spike Structure (SPK-6)
Following the pattern established by SPK-1 through SPK-5:
- All probe code lives under `spikes/spk-6/` and is strictly throwaway.
- Production code (`apps/` and `packages/`) **must never import** code from `spikes/`.
- Dependency `@microsoft/mxc-sdk@1.0.1` is installed solely in `spikes/spk-6/package.json` with exact pinning (`--save-exact`).
- Results and evidence are committed to `docs/superpowers/spikes/SPK-6.md`.

---

## 3. SPK-6 Escape Suite & Feasibility Probe

The probe harness (`spikes/spk-6/probe.mjs`) tests six critical containment properties:

```
+-----------------------------------------------------------------------+
|                         Host Windows 11 PC                            |
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  |             MXC processcontainer (Unprivileged)                |  |
|  |                                                                 |  |
|  |  +------------------------+      +---------------------------+  |  |
|  |  | Worktree Directory     |      | System Toolchains         |  |  |
|  |  | (Read-Write)           |      | (Read-Only)               |  |  |
|  |  +------------------------+      +---------------------------+  |  |
|  |                                                                 |  |
|  |      X Prohibited: %USERPROFILE%\.ssh, .config\opencode, AWS   |  |
|  |      X Prohibited: External Network (Egress Denied)             |  |
|  |      X Prohibited: Windows Credential Manager / DPAPI Secrets  |  |
|  |      ✓ Allowed: Loopback to Model Gateway (127.0.0.1:<port>)   |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

### 3.1 Probe Test Cases

| # | Probe | Test Action | Expected Result | Pass Criteria |
|---|---|---|---|---|
| **1** | **Unprivileged Creation** | Initialize container under standard user account | Container handle obtained without elevation | `exitCode == 0` |
| **2a**| **Worktree Write** | Create & write file inside story worktree | File written to disk | Byte-identical file exists |
| **2b**| **User Profile Guard** | Attempt to read `%USERPROFILE%\.ssh\id_rsa` & `%USERPROFILE%\.config\opencode` | Read rejected at OS/filesystem level | `EACCES` or path not found |
| **2c**| **Traversal Guard** | Attempt `..\..\Windows` and symlink/NTFS junction traversal | Access blocked | Traversal denied |
| **3** | **Credential Isolation**| Run `cmdkey /list` and `CredReadW` inside container | Host secrets inaccessible | 0 entries / empty output |
| **4a**| **External Egress Deny**| `fetch('https://example.com')` or socket to public IP | Connection dropped or refused | Network unreachable |
| **4b**| **Gateway Loopback** | `fetch('http://127.0.0.1:<mockPort>/v1/models')` | Connection succeeds | HTTP 200 OK |
| **5** | **Toolchain Usability** | Run `git init`, `git add`, `git commit`, `node -v` | Toolchains function without IPC crash | Exit code 0 |
| **6** | **Performance & Memory**| Benchmark startup latency and peak RAM | Acceptable overhead (< 1500 ms cold, < 80 MB RAM) | Measured values recorded |

---

## 4. Orchestrator Integration Architecture

### 4.1 The `IsolationRunner` Abstraction
In `apps/orchestrator/src/isolation/runner.ts`:
```ts
export interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut?: boolean;
}

export interface IsolationOptions {
  worktreeDir: string;
  allowedPorts?: number[];
  env?: Record<string, string>;
  timeoutMs?: number;
  memMb?: number;
  maxProcs?: number;
}

export interface IsolationRunner {
  readonly kind: 'mxc' | 'job_object';
  run(command: string[], options: IsolationOptions): Promise<ProcessResult>;
  dispose?(): Promise<void>;
}
```

### 4.2 Adoption Path (If SPK-6 is GO)
1. **Runner Implementation:** Create `MxcIsolationRunner` (`apps/orchestrator/src/isolation/mxc.ts`).
2. **Wiring:**
   - [`apps/orchestrator/src/checks/run.ts`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/apps/orchestrator/src/checks/run.ts) delegates check execution through `IsolationRunner`.
   - [`apps/orchestrator/src/git/worktree.ts`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/apps/orchestrator/src/git/worktree.ts) executes git worktree operations under the container.
   - `aiide-helper.exe` continues to provide process lifecycle tree-killing (`KILL_ON_JOB_CLOSE`) as a secondary safety layer.
3. **Spec Amendment:** Update §21.4 and mark REL-1 acceptance criteria satisfied.

### 4.3 Fallback Path (If SPK-6 is NO-GO)
1. **Runner Implementation:** Create `JobObjectIsolationRunner` (`apps/orchestrator/src/isolation/job-object.ts`) wrapping `aiide-helper.exe`.
2. **Hardening:**
   - Redirect all temporary profile paths (`USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`) to isolated scratch directories under `%LOCALAPPDATA%\AiKanban\tmp\<runId>`.
   - Mandatory secret scanner runs before and after check/implement execution.
3. **Roadmap Promotion:** Promote `ADV-2` (separate low-privilege Windows user account with restricted ACLs) for implementation when elevated isolation is needed.

---

## 5. Definition of Done for Sub-Project 4.1

1. `spikes/spk-6/` contains the runnable probe suite and package manifest.
2. `docs/superpowers/spikes/SPK-6.md` contains the complete empirical evidence, measured metrics, and explicit **GO / NO-GO** verdict.
3. If GO: `IsolationRunner` is implemented, tested with 100% passing tests, and wired into the orchestrator.
4. If NO-GO: Fallback `JobObjectIsolationRunner` is formalized with clean test coverage, and design spec §21.4 is amended with the empirical findings.
5. Verification gates pass cleanly: `npm run check:pins && npm run lint && npm run typecheck && npm test`.

---

## 6. Resolution & Empirical Findings

The SPK-6 automated escape and feasibility probe suite executed on 2026-10-23 (see full evidence in [`docs/superpowers/spikes/SPK-6.md`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/docs/superpowers/spikes/SPK-6.md)):
- **Unprivileged Container Creation:** [V] Standard user tokens successfully initialize `processcontainer` (`isSupported === true`).
- **Filesystem Deny Paths:** [V] Attempts to read `%USERPROFILE%\.ssh`, `%USERPROFILE%\.config\opencode`, and parent directories via directory traversal are blocked with `Access is denied`.
- **Credential Manager Isolation:** [V] Inside the container, `cmdkey /list` returns `* NONE *`, isolating host secrets.
- **Unprivileged Toolchain Viability:** [V] Developer toolchains (`node.exe`, `git.exe`, `npm`) fail at launch with exit code **`-1073741502` (`0xC0000142 STATUS_DLL_INIT_FAILED`)** due to missing `ALL APPLICATION PACKAGES` NTFS ACLs on `C:\Program Files\nodejs\` and `C:\Program Files\Git\`. Granting these permissions requires Administrator privileges, violating the core unprivileged constraint.

### Architectural Decision:
- **Verdict:** NO-GO for direct unprivileged MXC toolchain containment.
- **Path B Adopted:** `JobObjectIsolationRunner` implemented in [`apps/orchestrator/src/isolation/`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/apps/orchestrator/src/isolation) wrapping the verified Go Job Object helper with process-tree cleanup (`KILL_ON_JOB_CLOSE`), memory caps (code 137), process caps, environment scrubbing, and temporary scratch directory redirection.
- **Roadmap:** Story `ADV-2` (dedicated secondary low-privilege Windows user sandbox via `CreateProcessWithLogonW`) is promoted for future multi-user privilege boundaries.

