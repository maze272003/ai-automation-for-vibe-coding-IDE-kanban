# Run Interruption & Lease Liveness: make stop/cancel actually stop work (EXE-13 completion)

> Scope: close the highest-severity Phase 2 gap found in the 2026-10-19 review. This plan
> supplements `2026-10-18-phase-2-autonomous-execution.md` (Task: EXE-13 remainder) and the
> merge-integrity plan (runtime-level heartbeat for AC 4).

## Goal

Make the state machine's interruption contract true at runtime:

- `stop_run`, `cancel` and system `fail(interrupted)` actually stop in-flight work for the story:
  the active OpenCode session is interrupted (or a running check process tree is killed), the
  stop is observed by the in-flight poll loop, and the job ends without side effects.
- The workflow service executes the `interrupt_active_run` effect after commit via an injectable
  hook (the DB transaction stays synchronous and side-effect free).
- `cancel_jobs` cancels both `queued` and `leased` durable jobs for the story (T13/T17:
  "Active run interrupted and process tree killed; lease released").
- `AgentRunner` heartbeats the lease while a handler runs (default every 20 s, FND-7), so long
  plan/implement/review/merge jobs no longer expire their 60 s leases; a lost lease suppresses
  follow-up enqueues.
- The Kanban card exposes Stop run (when a run is active), Hold and Unhold actions using the
  existing human events.

## Non-goals

- `reject_plan` / `answer_clarifications` flows (separate gap, next cycle).
- Job-Object containment and a general process registry (EXE-2).
- Real cause checks for `recover` (`causeResolved` stays `true` this cycle).
- GitHub publishing/remote merge paths.
- New Playwright e2e for interruption (fixtures exist; deferred until the loop is e2e-stable).
- §18.5's escalation "if the session isn't idle within 30 s, restart the server" (server supervision
  is EXE-4 scope). Accepted limitation: if the interrupt HTTP call fails and no handle is
  registered, the local poll loop still aborts but the OpenCode session process may outlive the
  stop until server supervision lands; likewise I6's registry-based *verification* (process
  registry) is deferred with EXE-2.

## Authoritative requirements

- Spec §27 EXE-13 AC 4: "Stop kills the tree → BLOCKED(`interrupted`)"; AC 1 hints already ship.
- Spec §16.3 T13/T17 side effects: "Active run interrupted and process tree killed; lease released".
- Spec §16.6 I6 (CANCELLED ⇒ no running process for the story) and I9 (a completion from a stale
  worker never changes state).
- Spec §15/FND-7: leases with heartbeat every 20 s; at most one heavy job.
- Spec §18.5: `POST /api/session/{id}/interrupt` is the interrupt mechanism (verified in SPK-1).
- Spec §6.10 failure table rows for orchestrator crash / run limits.
- Merge-integrity plan AC 4 (runtime heartbeat during long merges).

## Assumptions (Joe)

- The status transition happens first (synchronously, as today); interruption is a best-effort
  post-commit side effect. If the interrupt HTTP call fails, the stop flag still makes the local
  poll loop abort, and the job fails — the story is already BLOCKED/CANCELLED, so this is safe.
- One interruptible run per story at a time (I10) — the registry keeps a single slot per story.
- `runOneShot` returns a structured `interrupted: true` flag on a stop request (no string
  sentinel coupling); the agent layer records the `agent_runs` row as `interrupted` then.
- Heartbeat interval is a runner dependency (default 20 000 ms) rather than derived from the
  queue's private lease configuration.
- UI actions reuse `POST /stories/:id/transitions` with `expectedVersion`; no new endpoints.

## Shared contracts (frozen by the lead before dispatch)

```ts
// apps/orchestrator/src/agents/interrupts.ts (created by lead, tested by WS-B)
export interface InterruptibleRun { runId: number; stop: () => Promise<void> | void }
export class RunInterruptRegistry {
  register(storyId: number, run: InterruptibleRun): void   // replaces any previous handle
  unregister(storyId: number): void
  isStopRequested(storyId: number): boolean
  requestStop(storyId: number): Promise<void>              // sets flag, calls stop() if registered
  activeStoryIds(): number[]
}

// apps/orchestrator/src/agents/runtime.ts (types seeded by lead, behaviour by WS-A)
export interface RunOneShotInput {
  /* existing */ shouldStop?: () => boolean
}
export interface RunOneShotOutput {
  /* existing */ interrupted?: boolean   // structured flag; agents record status 'interrupted'
}
// OpenCodeRuntime.interrupt(sessionId: string, directory: string): Promise<boolean>

// apps/orchestrator/src/workflow/service.ts (WS-B)
export interface WorkflowServiceDeps {
  /* existing */ onRunInterrupt?: (storyId: number, runId: number) => Promise<void> | void
}
// transitionIn() additionally returns `interrupts: { storyId: number; runId: number }[]`
// collected from interrupt_active_run effects. WorkflowService.transition() fires the hook
// after commit. StoryService.transition (the HUMAN path, which commits through transitionIn
// inside its own transaction) calls workflow.emitInterrupts(interrupts) after its commit —
// the BA review found the human path never calls transition(), so both entry points must
// fire the hook (BA condition C1).
```

## File ownership

| Workstream | Owned files |
|---|---|
| A. Runtime interrupt | `apps/orchestrator/src/agents/runtime.ts`, `apps/orchestrator/test/agent-runtime.test.ts` |
| B. Registry + workflow effect | `apps/orchestrator/src/agents/interrupts.ts`, `apps/orchestrator/src/workflow/service.ts`, `apps/orchestrator/src/stories/service.ts` (post-commit interrupt emission on the human path, BA C1), `apps/orchestrator/test/interrupts.test.ts` (new), `apps/orchestrator/test/workflow-service.test.ts` |
| C. Runner heartbeat/lease | `apps/orchestrator/src/agents/runner.ts`, `apps/orchestrator/test/runner.test.ts` |
| D. Check-tree kill + verify wiring | `apps/orchestrator/src/checks/run.ts`, `apps/orchestrator/src/verify/runner.ts`, `apps/orchestrator/test/checks-run.test.ts`, `apps/orchestrator/test/verification.test.ts` |
| E. Agent registration | `apps/orchestrator/src/agents/planner.ts`, `apps/orchestrator/src/agents/implementer.ts`, `apps/orchestrator/src/agents/reviewer.ts`, `apps/orchestrator/test/planner.test.ts`, `apps/orchestrator/test/implementer.test.ts`, `apps/orchestrator/test/reviewer.test.ts` |
| F. UI controls | `apps/ui/src/components/kanban/card.tsx`, `apps/ui/src/components/kanban/move-menu.tsx`, `apps/ui/src/components/kanban/terminal-modal.tsx`, `apps/ui/src/lib/transitions.ts` (decision: actions call the API directly from these components; `board.tsx` is NOT edited — it stays with the merge-integrity plan's ownership) |
| G. Cross-cutting integration test | `apps/orchestrator/test/run-interruption.test.ts` (new) |
| Lead integration | `apps/orchestrator/src/app.ts`, contract seeding, final review, plan/report |

No workstream may edit another workstream's files. Re-read every file immediately before editing
and preserve unrelated uncommitted changes (the tree contains the user's merge-integrity work).

## Acceptance criteria

1. `stop_run` on a story with an active run: the story becomes BLOCKED(`interrupted`), the
   registry's stop is invoked, the in-flight `runOneShot` aborts within a bounded wait, and the
   `agent_runs` row ends `interrupted` (not `failed`) when the abort came from the stop flag.
2. `cancel` while a job is leased: queued and leased jobs for the story become `cancelled`, the
   run aborts, the story is CANCELLED, and discovery does not re-enqueue it (cancelledAt guard).
3. Both transition entry points fire the interrupt hook post-commit (never inside a transaction):
   `WorkflowService.transition()` and the human path `StoryService.transition()` (which commits
   via `transitionIn`), once per `interrupt_active_run` effect, with the effect's `runId`.
4. The runner heartbeats during handlers: with a lease shorter than the handler duration, a
   second claimer gets `null` and `heartbeatAt` advances; follow-up enqueues (e.g. implement
   after plan) are suppressed when `complete()` reports a lost lease.
5. A registered check-process stop handle kills the process tree of the running check
   (grandchild processes included) and the verification run does not record a pass.
6. The UI offers Stop run for stories with an active run, and Hold/Unhold where applicable,
   sending the existing transition events with `expectedVersion` and surfacing guard failures.
7. `npm run check:pins && npm run lint && npm run typecheck && npm test` passes; pre-existing
   failures (none at baseline) are reported separately.

## Risks / migration

- No schema migration; no new dependencies.
- `interrupt` may be slow or refused by a wedged OpenCode session: the stop flag alone must still
  terminate the local poll loop (fail-safe), and the bounded wait must be strictly shorter than
  the runner's handler patience.
- Cancelling `leased` rows makes a running handler's `complete()` a silent no-op by design
  (lease/status match); follow-up enqueues must therefore be gated on `complete()`'s return.
- UI files carry uncommitted user changes; edits must be surgical re-reads, not rewrites.
- The whole merge-integrity batch is still uncommitted user work; it is complete and green
  (baseline: check:pins/lint/typecheck pass, 45 files / 463 tests, captured 2026-10-19 before
  this plan). Per `agent-loop/guard.md` it will NOT be committed by agents; every edit to a file
  it touched (`runner.ts`, `verify/runner.ts`, `terminal-modal.tsx`, `app.ts`, tests) must
  re-read first and preserve unrelated hunks. Verification gates run on the full tree.

## Outcome (2026-10-19, cycle 1)

Implemented by workstreams A–G plus lead integration; verified by independent QA and BA review.

- Final gate: `check:pins` ✅, `lint` ✅, `typecheck` ✅, `npm test` **48 files / 523 tests**
  (baseline 45/463; +60 tests, zero regressions). QA verdict: **PASS with notes**; BA verdict:
  **accept with documented limitations**.
- Post-review repairs (attempt 1, both verified FIXED by QA):
  - **D1**: `cancel_jobs` with no active run now yields a story-scoped post-commit interrupt
    (`runId` omitted) so a stop during TESTING reaches the verification kill handle; UI Stop
    predicate switched from `activeRun != null` to `ACTIVE_STATUSES` (matches the T13 guard,
    covers TESTING, removes the always-failing Stop during NEW planning).
  - **QA-B**: `RunInterruptRegistry.register()` clears a stale stop flag, so the boot sweep's
    `fail(interrupted)` can never poison the next run after `recover`.
- Follow-ups recorded (not fixed this cycle):
  - **D2 (low)**: a stop landing after all checks passed can leave a resumed TESTING story
    without a re-driven T5 (pre-existing discovery shape; fix on T16 resume: re-fire
    `verification_passed` or re-enqueue verify when a passed run exists).
  - **R1/R2 (low, QA)**: seconds-wide claim→register stop window wastes an orphan run without
    interrupting it; a later orphan `unregister` can clobber a newer run's handle. A registry
    run-epoch token would close both.
  - **D3 (info)**: production hook ignores `runId` (safe under I10); **D4 (info)**: no
    route-level tests for `stop_run`/`hold`/`unhold`; **L3**: UI e2e gap for the new controls.
  - **L1/L2** remain as documented non-goals (§18.5 server-restart escalation; EXE-2 registry
    verification of I6).
