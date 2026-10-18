# SPK-1 — OpenCode pinned isolated server (2.0.32)

**Date:** 2026-10-18 · **Executor:** SPK-1 subagent (OpenCode / GLM-5.3) · **Binary:** spikes/spk-1/node_modules/@opencode/cli/bin/opencode.exe (`--version` output: `opencode v2.0.32`)

**Install note (npm allowScripts):** npm 12's allowScripts blocked the `@opencode/cli` package postinstall, so the binary was not hard-linked on install. The lead ran `node …\@opencode\cli\…\postinstall.mjs` manually; it hard-links `opencode.exe` from the locally installed `@opencode/cli-windows-x64` platform package — a local copy, no network. The managed install in spec §18.2 must account for this (allow-scripts approval or running the postinstall explicitly after `npm ci`).

All evidence paths below are relative to `spikes/spk-1/out/` (gitignored by design; kept as experiment artifacts). Extra probes beyond the plan's experiments a–h are `out/probe-envdeny.mjs` (variants A–E) and `out/probe-shellaction.mjs` (S1–S2); their transcripts are `out/probe-*-messages.json`.

## Results

| # | Question | Result | Evidence | Marker |
|---|---|---|---|---|
| 1 | Server ready time | 1021 ms cold (incl. DB bootstrap, 50 migrations, ~35 ms) | harness console output for `a`; `server-*.log` | V |
| 2 | Session/prompt/interrupt/event/permission-reply operations exist | All five present among 143 operations: `POST /api/session session.create`, `POST /api/session/{sessionID}/prompt session.prompt`, `POST /api/session/{sessionID}/interrupt session.interrupt`, `GET /api/event event.subscribe`, `POST /api/session/{sessionID}/permission/{requestID}/reply session.permission.reply` | `operations.txt` | V |
| 3 | Session-deletion operation (Q-4) | `DELETE /api/session/{sessionID}` — operationId **`session.remove`** | `operations.txt` | V |
| 4 | Shell pinning config key (Q-4) | Top-level config key **`shell`** (string, "Default shell to use for terminal and shell tool execution") in the published schema `https://opencode.ai/config.json`. NB: `https://opencode.ai/v2/config.json` **404s** (HTML). Env var `OPENCODE_GIT_BASH_PATH` also works and is what the harness used; resolved shell confirmed via `GET /api/config/shell` → `C:\Program Files\Git\bin\bash.exe` (see `provider-isolation.json`) | `config-schema-alt.json` (64963 bytes, `$id: https://opencode.ai/config.json`); `config-schema.json` (the 404 HTML) | V |
| 5 | Canary leakage (claude/agents/config skills, parent AGENTS.md) | All four `leaked*` fields `false` — no `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills`, or parent-directory `AGENTS.md` content reached the model (temp HOME + `OPENCODE_DISABLE_CLAUDE_CODE=1`; the real home was never touched) | `canary-check.json` | V |
| 6 | Provider isolation (only `mock` visible) | `GET /api/provider` → exactly `opencode` (built-in free gateway, `apiKey: "public"`, baseURL `https://opencode.ai/inference/openai/v1`) and `mock`. **No personal providers** (no `zai-coding-plan`, no credentials from the real home). The built-in `opencode` provider is always present — see Corrections | `provider-isolation.json` | V |
| 7 | Reviewer edit/write denied, file unchanged | `unchanged: true`, `gitStatus` empty (SHA-256 identical). Denial mechanism: permission-filtered tool availability — `edit`/`write` are not in the reviewer's tool list, so the calls fail with tool-execution error `No tool named "edit"/"write" is currently available` (status `error`, `executed: false`) | `reviewer-result.json`; `session-messages-aik-reviewer.json` | V |
| 8 | Implementer: git push denied / outside write blocked / .env not read | push denied (`permission.rejected`, "Permission denied: shell"); outside write denied ("Permission denied: external_directory"), `outsideFileExists: false`; **but `.env` was read: `envContentReachedModel: true`** — the plan's `deny('read','**/.env*')` does not match a root-level `.env`. Probes: exact `.env` and bare `.env*` denies DO block (root), `**/.env*` blocks only nested (`sub/.env`) | `implementer-escape.json`; `session-messages-aik-implementer.json`; probes A–E | **U → corrected** |
| 9 | Interrupt → idle time; taskkill /T leaves no opencode.exe | `interruptStatus: 200`; session idle **4 ms** after interrupt (first 250 ms poll); `taskkill /PID <pid> /T /F` removed the whole tree — remaining `opencode.exe` PIDs 8236 and 4972 both predate the spike (user's own sessions, started 10:32/12:37 vs. experiments ~15:0x) | `interrupt.json` | V |
| 10 | stdin close → exit | Exit code `0` in **58 ms** | `stdin-close.json` | V |
| 11 | Per-session permissions semantics (Q-5) | `createStatus: 200`; **`sessionAllowEditOverrodeAgentDeny: true`** — a per-session `allow(edit)` overrode the agent's rule set (the write executed: recorded tool result "Wrote file successfully: target.txt"). Session rules are evaluated **after** agent rules ⇒ **the orchestrator must never pass allow rules per session** — only deny rules (or none) | `session-permissions.json`; `recorded-h/request-003.json` | V |
| 12 | Tool names + argument keys | 6 tools offered to `aik-implementer` under global `deny(*)` + the agent's allows. Keys are `path`, **not** `filePath`; `shell` has **no** `description` parameter | `tools.json` | V |

Tool table (from `tools.json`, i.e. what OpenCode 2.0.32 actually sent the model):

| Tool | Required args | Optional args |
|---|---|---|
| `edit` | `path`, `oldString`, `newString` | `replaceAll` (bool) |
| `glob` | `pattern` | `path`, `hidden` (bool), `limit` (int) |
| `grep` | `pattern` | `path`, `include`, `literal` (bool), `caseSensitive` (bool), `limit` (int) |
| `read` | `path` | `offset`, `limit` |
| `shell` | `command` | `workdir`, `timeout` (ms), `background` (bool) — **no `description`** |
| `write` | `path`, `content` | — |

All schemas are `additionalProperties: false`, so extra keys (e.g. v1's `filePath`, `shell.description`) make the call invalid.

## Corrections needed to spec §18

1. **§18.5 Create row — `model` shape.** `POST /api/session` rejects the v1-style string: `400 {"message":"Expected Model.Ref | null\n  at [\"model\"]"}`. It must be an object: `{ "id": "p_12", "providerID": "gateway" }` (optional `variant`). The string `provider/model` form remains correct **inside `OPENCODE_CONFIG_CONTENT`** agent defs (`/api/config` echo normalized `mock/mock-model` to `{providerID, model}`).
2. **§18.5 Prompt row — body shape.** `POST /api/session/{id}/prompt` takes a flat `{ "text": "…" }` (plus optional `delivery`, `files`, `agents`, `skills`, `metadata`, `resume`, `id`); there is no `parts` array (`additionalProperties: false`).
3. **§18.4 — `.env` deny pattern is wrong.** `{"action":"read","resource":"**/.env*","effect":"deny"}` does **not** match a root-level `.env` (`**/` requires ≥1 directory segment in OpenCode's matcher). Use both `{"action":"read","resource":".env*","effect":"deny"}` (root) and `{"action":"read","resource":"**/.env*","effect":"deny"}` (nested). Evidence: probes A (deny-first still allowed), B (exact `.env` denied), C (as-plan allowed), D (`sub/.env` denied by `**/.env*`), E (`.env*` denied root).
4. **§18.4 — rule evaluation order confirmed, and per-session semantics amended.** Last matching rule wins (probe A: deny→allow = allowed; B/C differ only by pattern). Per-session `permissions` are evaluated **after** agent rules and can override them (experiment h) — the spec's "add the worktree-specific rules" is therefore **additive-and-overriding**. Design constraint: the orchestrator may pass only **deny** rules per session, never allow rules.
5. **§18.4 — shell permission action name.** In rule form the action is **`shell`** (v2), not `bash`: `allow('shell','echo *')` permitted execution (probe S1) while `allow('bash','echo *')` left the tool unavailable entirely (probe S2 — the call errors "No tool named shell…"). The published config schema's *object-form* `permissions.bash` key is a legacy alias; don't use it for v2 rules.
6. **§18.4/§18.6 — two-layer permission behavior.** Action-level rules gate **tool availability** (a tool with no matching allow is omitted from the tool list sent to the model); resource-level rules fail at **execution** with `error.type: "permission.rejected"`, `message: "Permission denied: <action|external_directory>"`. Contract tests should assert both layers separately.
7. **§18.3 — config schema URL.** `https://opencode.ai/v2/config.json` 404s; the live schema is `https://opencode.ai/config.json` (JSON Schema draft 2020-12). `snapshots`, `steps`, and `policies` all exist in it, so §18.4's illustrative shape is otherwise valid.
8. **§18.5 Retention — [U] → [V].** `session.remove` (`DELETE /api/session/{sessionID}`) confirmed; also available: `session.fork`, `session.move`, `experimental.session.export/import`.
9. **§18.2 — managed install.** See the allowScripts note above: `npm ci` alone leaves the binary unlinked under npm 12; the postinstall must be allowed/run explicitly (local platform package, no network).
10. **§18.5 — always pass `title` when creating sessions.** A session created without `title` triggers an extra title-generation model call (it consumed the mock's first scenario turn in the probe). §18.5 already sends a title; keep it mandatory in the adapter (and account for the extra call in mock-driven contract tests if it's ever omitted).
11. **§18.7/§9 — built-in `opencode` provider is always visible.** `GET /api/provider` always includes the built-in `opencode` gateway (`apiKey: "public"`, free models such as `glm-5.3-flash-free`, `nemotron-*`). It is not user data and not a leak, but "only the gateway provider is visible" must be phrased as "no *personal* providers are visible; filter models by `providerID`". Agents and sessions pin the model explicitly, so accidental use is prevented by construction; optionally assert in the contract suite that no credentials-backed providers appear.
12. **Isolation environment (§18.3) — all env vars behaved as specified** (`OPENCODE_CONFIG_CONTENT` won precedence — `/api/config` echoes the generated document; `OPENCODE_DB`, XDG redirects, `OPENCODE_DISABLE_PROJECT_CONFIG/CLAUDE_CODE/FILEWATCHER` all held; no skill or parent-AGENTS.md leakage).

## Verdict

**Server mode: GO.**

- Readiness ~1 s; clean lifecycle primitives measured: interrupt → idle 4 ms, stdin close → exit(0) in 58 ms, `taskkill /T /F` leaves no descendants.
- Full operation set present (143 ops), including everything §18.5 needs plus `session.remove` for retention.
- Isolation held: zero personal providers, zero skill/instruction leakage into a temp HOME.
- Permission enforcement is real where rules match (files byte-identical; push and outside-write denied at execution), with two sharp edges to encode in the config generator (`.env` glob fix, session-rules-come-last constraint) — both are orchestrator-side fixes, not OpenCode defects.
- The `run --standalone --format json` fallback (§18.6 `OpenCodeRunCliRuntime`) is not needed on this evidence; keep it as a documented contingency only.

**Harness/scenario deviations from the plan's verbatim code** (all recorded per the plan's Step 4/7 instructions):
1. `harness.mjs` (`runSession`, experiments `e` and `h`): `model: 'mock/mock-model'` → `model: { id: 'mock-model', providerID: 'mock' }` (v2 `Model.Ref`; string form → 400).
2. `harness.mjs` (same three call sites): prompt body `{ parts: [{ type: 'text', text: prompt }] }` → `{ text: prompt }` (v2 flat body).
3. `scenarios/reviewer-edit.json` and `scenarios/implementer-escape.json`: `filePath` → `path` (edit/write/read); dropped `shell`'s `description` argument (not in the v2 schema; `additionalProperties: false`).

The vendored API spec is copied to `docs/superpowers/spikes/opencode-2.0.32-openapi.json`.
