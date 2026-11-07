# Implementation plan: Phase 6 runtime event foundation

Status: GLM SATISFIED (2026-11-08; minors incorporated). Previous status: DRAFT — implementation awaits GLM 5.3 satisfaction on this plan and its [specification](../specs/2026-11-07-phase-6-next-runtime-events.md).

## Ranked continuation

1. Existing 6.1a-06 normalized stream events: high confidence, medium effort, moderate parsing/privacy risk; enables subsequent runtime integration. Selected.
2. Existing 6.1a-08 shared runtime interface/OpenCode adapter: high developer value, medium effort; depends on 06 and missing/reconciled 01 contracts. Next slice.
3. Desktop notification preferences and multi-file editor tabs: useful optional usability work; defer until the current runtime sequence has a verified baseline.

## Review and execution

1. Coordinator records baseline checks and preserves existing changes. GLM reviews both new documents against original 6.1a-06/§5.3 and actual source. Codex resolves findings; each re-review is a new review task. Implement only after satisfied.
2. Freeze the event union from original task 6.1a-06 plus parser state and `toActivity(event): RunActivityEvent | null` signatures before parallel edits. Types owner sends these interfaces to other workers first. Activity conversion belongs to `run-activity.ts`.
3. Parser worker owns new `apps/orchestrator/src/agents/runtimes/types.ts`, `claude-stream.ts`. Implement RE1–4 with no process/network/filesystem side effects. Do not implement the future full AgentRuntime interface here.
4. Activity worker owns `apps/orchestrator/src/agents/run-activity.ts`, `run-events.ts`, and `apps/orchestrator/test/run-activity.test.ts`. Implement RE5–6, extending existing discriminated activity shape and persistence with exhaustive type handling. Redact all strings introduced into persistence, preserve legacy result shape. Inspect consumers and report required changes outside ownership to coordinator before editing.
5. Test worker owns new `apps/orchestrator/test/claude-stream.test.ts` and existing `office-bridge.test.ts`. Replay committed fixture content without spawning CLIs; add explicit synthetic frames for gaps and label provenance honestly. Test exact normalized sequences, repeat finals, independent states, malformed input, complete-versus-partial text, nullable usage, tool identity and unknown types. Assert Office ignores new event types. Coordinate API assertions before implementation; tests may initially fail.
6. Coordinator owns integration and any required consumer adjustments outside those lists. Test persistence redaction and bounded output using existing temp DB helpers. No simultaneous edits to shared files. Request independent GLM code/BA review after tests; fix findings and re-review as necessary.

## Validation and traceability

RE1–4 → types/parser + claude-stream tests. RE5 → activity conversion + run-activity and Office tests. RE6 → run-events persistence + activity integration tests. A test must examine persisted payloads, not only call a mocked redactor.

Run targeted tests for claude-stream, run-activity, office-bridge and existing CLI JSONL/transcript modules. Then run `npm run check:pins`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, recording exact exit statuses and separating baseline failures. Inspect full diff for privacy, compatibility, and unintended changes. No commits or publication required for this slice.

## Completion record

Completed 2026-11-08 (GLM 5.3 executor after Codex credit exhaustion; user-mandated handoff):

- Implementation: `runtimes/types.ts` (RuntimeEvent union, RE1), `runtimes/claude-stream.ts` (pure `decodeClaudeFrame`, RE2–4), `run-activity.ts` `toActivity` + extended `RunActivityEvent` (RE5), `run-events.ts` `persistedActivity` redaction (RE6). Codex authored the implementation and initial tests; GLM workers appended the remaining RE5/RE6 redaction tests, denied/command/usage frame tests, and the multi-block text-join case.
- Verification (Claude runner): targeted suites 4 files/40 tests PASS; cli-jsonl + cli-transcript + agent-runtime 46 tests PASS; `check:pins` PASS; `build` PASS; `npm test` 1259 pass/36 fail/1 skipped — failed set identical to the pre-existing baseline (missing `src/process/*` modules, agent-team contract exports); lint/typecheck failures all pre-existing. No new failures.
- Independent GLM review: SATISFIED, 0 blockers, 0 majors. Carried-forward notes for later slices: (1) a stream emitting both top-level `command` frames and Bash `tool_use` for one execution may double-count `commandsPerRun` — dedupe at the 6.1b-05 counter or the live-protocol acceptance gate; (2) `message` events will consume the 300-row `RUN_ACTIVITY_ROW_CAP` once wired — filter in the future CLI runtime's onActivity if tool bubbles get crowded out; (3) `result.structured` strings are unvalidated until the 6.1a-12 zod boundary; (4) make `appendRunActivity`'s `redact` parameter required when the first runtime caller lands (6.1a-11).
- Compat audit (read-only): no consumer breaks; SSE/contracts/UI/desktop paths are payload-blind; Office bridge ignores non-tool kinds; no unredacted-text path.
- Not done by design: no commit (working deviation, resolution 5), no `run.output` producer (resolution 4), no CLI runner wiring, no new dependencies or migrations.

Do not mark the broader Phase 6 complete. Next planned increment is 6.1a-08 after confirming 6.1a-01 contracts are available (agent-team contract exports are still the failing baseline). Missing external brainstorming/Graphify/OpenSpec tools are not assumed executed; repository evidence and structured review provide the planning fallback.

## GLM review resolutions (2026-11-08)
1. Test worker owns any new synthetic fixture files and their manifest entries; inline synthetic frames are preferred when no replay file is needed.
2. Partial stream_event deltas are dropped completely and tested.
3. Freeze extended RunActivityEvent fields as defined in the specification clarification, alongside RuntimeEvent and parser APIs. Parser state exposes malformedFrames: number. Other normalized kinds map to null.
4. Original run.output acceptance is deferred to adapter wiring 6.1a-10/11 because no producer exists. run.activity is covered here.
5. Working deviation: leave this slice uncommitted for review; the parent plan's per-task commit convention is deferred, and no commit is claimed.
Review result: SATISFIED, zero blockers. Baseline: pins/build pass; lint one existing type-import failure; typecheck missing process/contracts; tests 117 files pass, 3 fail, 1240 tests pass, 36 fail, 1 skipped.

