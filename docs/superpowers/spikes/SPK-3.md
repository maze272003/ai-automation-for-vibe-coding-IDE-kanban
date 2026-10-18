# SPK-3 — Job Object helper (Go)

**Date:** 2026-10-18 · **Executor:** SPK-3 subagent (OpenCode / GLM-5.3) · **Binary:** `spikes/spk-3/helper/aiide-helper.exe` (built from `spikes/spk-3/helper/main.go`, plan-verbatim, zero API deviations)

**Toolchain:** `go version go1.27.0 windows/amd64` (installed by the user via winget, `GoLang.Go`; first build shell needed the full path `C:\Program Files\Go\bin\go.exe` because the harness PATH predates the install). `go.mod`: `module aiide-helper-spike`, `go 1.26.0`, `require golang.org/x/sys v0.49.0`. `go mod tidy` kept v0.49.0 (no bump) and wrote `go.sum` (`h1:XbzkgYJHdqh/8m2Uu0W/dQv8nktxx4BFHp1M0gROTXA=` / `go.mod h1:hNLxWAXmnKAxqDtdwIYC4bM9oQPEecfsnNMuSxOs3og=`). The build (`go -C spikes/spk-3/helper build -o aiide-helper.exe .`) completed with **no output and no MSVC installed**, producing a 3,041,280-byte static exe. Every `x/sys/windows` symbol the plan used was verified against the v0.49.0 source before building (notably `SetInformationJobObject` returns `(ret int, err error)`, and the untyped `JobObjectExtendedLimitInformation = 9` constant satisfies both the `uint32` set-path and the `int32` query-path).

Evidence: `spikes/spk-3/out.json` (driver output, verbatim) and `spikes/spk-3/out/probe-maxprocs.mjs` (extra probe, transcript below). Driver: `node spikes/spk-3/run-experiments.mjs`.

## Results

| # | Experiment | Observed | Plan expectation | Evidence | Marker |
|---|---|---|---|---|---|
| 1 | `taskkill /F` on the helper (no `/T`) — KILL_ON_JOB_CLOSE must reap the tree | `childAlive: false`, `grandchildrenAlive: [false, false]` — the node root **and both grandchildren in libuv's nested job** died when the helper's last job handle closed | both false | `out.json` `killHelper` | V |
| 2 | Killing the "orchestrator" (`--parent-pid`) must end the job within 2 s | `helperAlive: false`, `grandchildrenAlive: [false, false]`, `msUntilGone: 1` — all targets were already dead at the *first* 100 ms poll, i.e. the helper's `WaitForMultipleObjects` → `TerminateJobObject` reaction completed within the `taskkill` call itself; far under the 2 s budget | helper + grandchildren gone, < 2000 ms | `out.json` `killParent` | V |
| 3 | Memory cap (`--mem-mb=300`, alloc 50 MB / 50 ms) → exit 137 | `exitCode: 137`; the child died of `ERR_MEMORY_ALLOCATION_FAILED` (commit failure at the job limit, visible in `stderrTail`) and the helper appended `aiide-helper: job memory limit exceeded` after its post-mortem `PeakJobMemoryUsed >= 98%` check | 137 | `out.json` `memoryCap` | V |
| 4 | Stdio relay byte-exact + exit-code propagation | `exitCode: 7`, `stdoutExact: true` (payload `héllo\r\nwörld\0end` round-trips byte-for-byte incl. NUL, CRLF, UTF-8 multibyte), `stderrExact: true` (bytes 0x00–0xFF untouched — no CR/LF or 0x1A text-mode translation) | 7, true, true | `out.json` `stdio` | V |
| 5 | Process-count cap (`--max-procs=2`, three sequential `spawnSync` children) | `exitCode: 0`, `output: ["ok","ok","ok"]` — **the plan's expectation ("at least one spawn failed") did not hold**: sequential spawns peak at root + 1 = 2 in-job processes, which *equals* the limit, not exceeds it. Enforcement itself is real — see the boundary probe below, where `--max-procs=1` makes every spawn fail (`UNKNOWN`) | ≥ 1 failure | `out.json` `maxProcs` + probe transcript | **U → corrected** |

**Boundary probe** (`spikes/spk-3/out/probe-maxprocs.mjs`, same spawn shape as experiment 5):

| `--max-procs` | Output | Meaning |
|---|---|---|
| 1 | `["UNKNOWN","UNKNOWN","UNKNOWN"]` | root already fills the quota; every `spawnSync` fails (libuv surfaces the refused `CreateProcess` as `UNKNOWN`) — **the ACTIVE_PROCESS cap is enforced** |
| 2 | 3 × `{status:0,signal:null}` | root + 1 child = 2 ≤ 2 → allowed; explains experiment 5 |
| 3 | 3 × `{status:0,signal:null}` | headroom → allowed |

Semantics: `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` limits the **total in-job process count, including the root process the helper spawns**; violation refuses creation rather than terminating the job.

## Corrections needed to spec §21.4

1. **§21.4 Job Objects row, Limits cell — "grandchildren survive libuv's own job [V]" is misleading.** What experiment 1 shows is the opposite once the helper is used: with `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread`, libuv's own (nested) job sits *inside* the helper's job, and `KILL_ON_JOB_CLOSE` reaps libuv's grandchildren along with everything else (`taskkill /F` without `/T` sufficed; spec §21.3's "kill-on-close … kills the whole tree" is the correct claim [V]). The genuine residual limits: it is not a security boundary (see statement below), and a process could try `CREATE_BREAKAWAY_FROM_JOB` — the helper's job does **not** set `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, so Windows refuses breakaway by construction [I].
2. **§21.4 Job Objects row, "memory, CPU and process caps" [V] → CPU cap is [U].** This spike verifies the memory cap (exit 137) and the process-count cap (probe above). CPU-rate control (`JOBOBJECT_CPU_RATE_CONTROL_INFORMATION` or affinity/`JOB_OBJECT_LIMIT_SCHEDULING_CLASS`) was **not** prototyped or measured; EXE-2 must implement and test it before the spec's [V] is earned.
3. **§21.4 / §13 threat row — process-count semantics.** "Process count (default 64)" must be read as 64 *total in-job processes including the root shell*; if 64 *children* are intended, set the limit to N+1.
4. **§SPK-3 description (§ "SPK-3: Job Object helper spike") — lifecycle trigger.** The spec text says the helper should "exit and kill the job when stdin or the parent pipe closes"; the prototype implements `--parent-pid` (`OpenProcess(SYNCHRONIZE)` + `WaitForMultipleObjects`), which worked (experiment 2) but is PID-reuse-sensitive in the long run. EXE-2's named-pipe / stdin-close trigger remains untested here [U].
5. **137 is a post-mortem classification, not a signal.** The helper can only report 137 after the root exits, by comparing `PeakJobMemoryUsed ≥ 98%` of the limit; processes inside the job experience the cap as allocation failures (e.g. node's `ERR_MEMORY_ALLOCATION_FAILED`). A child that dies of something else while peak < 98% correctly yields the child's own exit code. Document this in the UI's "run failed: memory cap" wording (§19 containment statement).

**Mandatory statement — this is resource and lifecycle containment, not a security boundary.** Job Object limits constrain memory, process count, and lifecycle (tree kill), and cannot constrain filesystem or network access; code still runs as the user (§21.4's UI statement stands unchanged).

## Verdict

**GO for EXE-2.**

- All lifecycle primitives measured and green: kill-helper reaps grandchildren (nested libuv job included), kill-parent ends the job within the kill call itself, stdio is byte-exact in both directions, exit codes propagate, memory cap maps to 137.
- Process-count cap is enforced (limit includes the root); the plan's experiment-5 fixture was constructed at the boundary — a fixture issue, not a containment gap (proved by the `--max-procs=1` probe).
- Build needs no MSVC; the `x/sys/windows` API family used compiled as written.
- Carried into EXE-2: CPU-rate control (untested, spec [U]), a non-PID-based parent-liveness trigger (named pipe / stdin close), and the N+1 process-limit convention.

**Deviations from the plan (all operational; zero changes to the plan's Go/JS code):**

1. `go.mod` was hand-authored (Go was absent during authoring) with exactly what the plan's Step 2 produces today — `aiide-helper-spike`, `go 1.26.0`, `x/sys v0.49.0` — then `go mod tidy` generated `go.sum` (kept v0.49.0, no bump, no toolchain line added).
2. `out.json` was written via a file write instead of PowerShell `>` redirection, which would have produced UTF-16LE under PS 5.1; content is the driver's verbatim stdout.
3. Extra evidence file `spikes/spk-3/out/probe-maxprocs.mjs` (gitignored `out/` dir, SPK-1 precedent) for the experiment-5 boundary interpretation.
