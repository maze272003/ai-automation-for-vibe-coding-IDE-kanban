# Phase 6 next slice: normalized runtime events

Status: GLM SATISFIED (2026-11-08; zero blockers, five minors incorporated). Previous status: DRAFT — awaiting GLM 5.3 review. Author: Codex.

This addendum scopes existing task 6.1a-06 from the Phase 6 plan and design §5.3 (TEAM-2). It does not replace the approved broader design. The next dependency is 6.1a-08; its runtime interface and OpenCode adapter are a subsequent slice after missing prerequisite 6.1a-01 is reconciled with the checkout.

## Developer need and evidence

Developers need reliable agent progress, final structured results, and usage reporting before adding more runtime choices. The checkout contains `runtimes/jsonl.ts`, `runtimes/transcript.ts`, and CLI fixtures, but lacks `runtimes/types.ts` and `claude-stream.ts`. `run-activity.ts` currently supports only tool-start/tool-end. Implementing the parser first closes an existing roadmap dependency rather than adding another disconnected UI feature.

External research, accessed 2026-11-07: [Conductor workflow](https://www.conductor.build/docs/concepts/workflow) describes isolated agent work and reviewable units; [Vibe Kanban documentation](https://www.vibekanban.com/docs) positions planning/review with multiple coding-agent integrations as its core workflow. These support prioritizing coherent runtime foundations; they do not establish requirements for this application.

## Scope and requirements

- RE1: Export the exact `RuntimeEvent` union specified by existing task 6.1a-06: session, message, tool-start, tool-end, command, subagent, usage, result, denied, unknown. Preserve the documented payload fields and nullable usage values.
- RE2: Export `createClaudeStreamState()` and pure `decodeClaudeFrame(frame: unknown, state: ClaudeStreamState): RuntimeEvent[]`. State is per run. Invalid shapes return no events, increment a malformed counter, and never throw; recognized but unsupported well-formed event types emit unknown events without exposing raw payloads.
- RE3: Parse fixture-backed initialization, assistant text/tool blocks, tool results, subagent relationships, denial, usage and terminal result frames. Preserve structured output even with empty textual result; terminal result is emitted once per state. Missing usage remains null, explicit zero remains zero; reject non-finite/negative token counts as unavailable.
- RE4: Use complete assistant message text for persistence-facing events; ignore partial text deltas rather than storing fragmented secrets. Unknown/malformed input must not be persisted by this parser. All persistence downstream still uses the redactor.
- RE5: Add `toActivity(event)` mapping for tool events and the new message/subagent/usage activity kinds while preserving legacy OpenCode activity behavior. The existing Office bridge must ignore unsupported kinds and continue showing tool activity.
- RE6: Existing run.activity persistence must retain new event payloads safely and redact all string fields before truncation. Exercise the existing run.output path if used; do not invent a second output channel or wire a CLI runner in this slice. Preserve existing row limits and story/run identity.

## Acceptance and limits

Fixture replay tests assert exact event lists, duplicate result suppression, null/zero usage, malformed and unknown cases, interleaved tool identities, and no partial-delta text emission. Persistence tests use a synthetic secret in message text, subagent name, and tool identifiers to prove no cleartext survives in saved events. Existing activity and Office tests remain green. Tests use OS-temp helpers and fake streams only.

No new dependencies, migrations, real CLI execution, model-routing changes, UI settings, or automatic runtime fallback. This is a foundation increment, not a completed desktop runtime integration. The user's Codex-to-GLM handoff instruction governs this development session; changing application fallback policy needs its own later specification.

## Working decisions

Codex writes specifications/plans; GLM 5.3 reviews until satisfied. Routine questions are resolved from repository evidence by either model. Codex limit/network failure hands unfinished work to GLM with a concrete brief when the orchestrator can still execute that handoff. No guarantee of handoff after total harness/network loss is implied. Maximum five workers requested; this runtime permits four total agents, so at most three workers plus coordinator. No historical Claude-only execution requirement applies to this slice.

Fixtures currently identify themselves as synthetic. Passing replay proves compatibility with those scenarios, not live CLI compatibility; never relabel them recorded. Live protocol confirmation remains a later acceptance gate for the CLI adapter.

## Review clarifications (2026-11-08)
Partial stream_event deltas emit no events, including no unknown event. Activity payloads are frozen as tool-start/tool-end {name, summary?}, message {text}, subagent {phase, id, name, ok?}, and usage {inputTokens, cachedInputTokens, outputTokens, costUsd}, with nullable numbers. Other RuntimeEvent kinds map to null. Every persisted model-controlled string is redacted before truncation.

