# SPK-6 — Microsoft MXC Isolation Spike (REL-1)

**Date:** 2026-10-23 · **Executor:** Antigravity · **OS:** Windows 11 Pro 10.0.26200 (x64) · **SDK:** `@microsoft/mxc-sdk@1.0.1` · **Spike Code:** `spikes/spk-6/probe.mjs`

## 1. Executive Summary

This spike evaluates **Microsoft MXC (`@microsoft/mxc-sdk@1.0.1`) `processcontainer`** to determine whether it can isolate agent execution and check runs on standard Windows developer environments without requiring administrator privileges (per design spec `docs/superpowers/specs/2026-10-23-phase-4-reliability-isolation-design.md` and parent spec §21.4 / §27 REL-1).

### Verdict: NO-GO for direct unprivileged MXC execution; Fallback to Path B (Enhanced Job Objects + ADV-2)

- **Positive Findings:**
  - Standard Windows user tokens can create MXC process containers (`getPlatformSupport().isSupported === true`).
  - Native Windows system utilities (`cmd.exe`, `cmdkey.exe`) run with low latency (64 ms cold, 72 ms warm).
  - Filesystem deny policies (`deniedPaths`) successfully block access to user profile secrets (`%USERPROFILE%\.ssh`, `%USERPROFILE%\.config\opencode`) and path traversal attempts with `Access is denied`.
  - Windows Credential Manager queries (`cmdkey /list`) inside the container return `* NONE *` (host credentials isolated).
- **Fatal Blocker (`STATUS_DLL_INIT_FAILED` / `0xC0000142`):**
  - Developer toolchains (`node.exe`, `git.exe`, `npm`) fail immediately upon launch inside MXC with exit code **`-1073741502` (`0xC0000142 STATUS_DLL_INIT_FAILED`)**.
  - Windows AppContainers require NTFS DACLs granted to `ALL APPLICATION PACKAGES` (`S-1-15-2-1`) on toolchain binaries and dependent DLLs (`C:\Program Files\nodejs\`, `C:\Program Files\Git\`).
  - Granting these permissions requires elevated Administrator privileges (`icacls ... /grant "*S-1-15-2-1:(OI)(CI)(RX)"`), which directly violates the core project requirement that AI Kanban agents must run strictly unprivileged as the standard user.

---

## 2. Probe Results Matrix

| # | Probe | Command / Action | Result | Exit Code | Marker | Pass Criteria |
|---|---|---|---|---|---|---|
| **1** | **Unprivileged Container Creation** | `cmd.exe /c echo unprivileged_ok` | SUCCESS (`unprivileged_ok`) | 0 | [V] | Unprivileged creation works |
| **2a**| **Worktree Write** | Write `test.txt` in scratch worktree | SUCCESS (file written) | 0 | [V] | Worktree is read-write |
| **2b**| **Denied Paths (Canary)** | Read outside canary secret | DENIED (`Access is denied`) | 1 | [V] | `deniedPaths` enforced |
| **2c**| **User Profile Secret Denied** | `dir "%USERPROFILE%\.ssh"` | DENIED (`Access is denied`) | 1 | [V] | SSH keys protected |
| **2d**| **Path Traversal Blocked** | `type ..\outside\canary.txt` | DENIED (`Access is denied`) | 1 | [V] | Traversal blocked |
| **3** | **Credential Manager Isolation**| `cmdkey.exe /list` | ISOLATED (`* NONE *`) | 0 | [V] | Host credentials hidden |
| **4a**| **External Network Egress** | `node.exe` socket to `1.1.1.1` | FAILED (`0xC0000142`) | -1073741502 | [V] | Toolchain fails to start |
| **4b**| **Loopback Gateway Allow** | `node.exe` fetch to `127.0.0.1:<mockPort>` | FAILED (`0xC0000142`) | -1073741502 | [V] | Toolchain fails to start |
| **5** | **Toolchain Usability** | `git.exe init`, `git.exe status`, `node.exe -v` | FAILED (`0xC0000142`) | -1073741502 | [V] | Developer tools unusable |
| **6** | **Latency Overhead** | 2 consecutive `cmd.exe` executions | Cold: 64 ms, Warm: 72 ms | 0 | [V] | Very fast process launch |

---

## 3. Detailed Root Cause Analysis

### What `0xC0000142` Means for Developer Toolchains
When Windows creates an AppContainer process, the NT kernel validates that every DLL loaded by the executable has read/execute access granted to the AppContainer package token or the well-known SID `ALL APPLICATION PACKAGES` (`S-1-15-2-1`).

Windows System32 binaries (`cmd.exe`, `cmdkey.exe`, `where.exe`) have this ACL by default. However:
- Standard installations of Node.js (`C:\Program Files\nodejs\node.exe`)
- Standard installations of Git for Windows (`C:\Program Files\Git\cmd\git.exe`, `bin\bash.exe`)
- Standard installations of Python
do **not** have `ALL APPLICATION PACKAGES` in their ACLs. When launched inside an unprivileged AppContainer, the NT DLL loader aborts initialization with `STATUS_DLL_INIT_FAILED (-1073741502)`.

Even supplying `filesystem: { readonlyPaths: ['C:\\Program Files\\nodejs'] }` in `@microsoft/mxc-sdk` cannot bypass the NT kernel ACL check without elevated ACL modification on the host filesystem.

---

## 4. Architectural Decision & Consequences

As mandated by design spec §2.1 and Phase 4 spec §4.3:
1. **Adoption of Path B (Hardened Job Objects):**
   - The orchestrator will **not** depend on `@microsoft/mxc-sdk`.
   - `IsolationRunner` will be implemented using `JobObjectIsolationRunner`, wrapping the verified Go containment helper [`spikes/spk-3/helper/aiide-helper.exe`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/spikes/spk-3/helper/main.go).
   - `aiide-helper.exe` guarantees:
     - `KILL_ON_JOB_CLOSE`: process-tree destruction preventing orphan grandchild processes.
     - `JOB_OBJECT_LIMIT_JOB_MEMORY`: hard memory cap with exit code 137.
     - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`: active process limit.
   - Enforce environment scrubbing: `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, and `TEMP` are redirected to dedicated temporary directories under `%LOCALAPPDATA%\AiKanban\tmp\<runId>`.
   - Automated pre-flight and post-flight secret scanning via [`apps/orchestrator/src/secrets/scan.ts`](file:///c:/Users/USER/Documents/data/ai-kanban-automation/apps/orchestrator/src/secrets/scan.ts).
2. **Roadmap Promotion:**
   - Story `ADV-2` (Dedicated low-privilege Windows user sandbox via `CreateProcessWithLogonW`) is promoted as the official high-security isolation mechanism for Phase 6.
