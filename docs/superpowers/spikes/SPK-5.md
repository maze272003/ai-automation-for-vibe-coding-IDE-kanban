# SPK-5 — Provider key isolation probes (P-1, P-2)

**Date:** 2026-10-23 · **Binary:** OpenCode 2.0.32 (pinned; run from a throwaway vendor dir — see "Binary provenance") · **Probes:** `spikes/spk-5/` (throwaway)

**Binary provenance.** The plan guessed the pinned binary lives at `spikes/spk-1/node_modules/@opencode/cli/bin/opencode.exe` — that directory is empty (npm allowScripts unlinked it since SPK-1). The OpenCode CLI on PATH is **2.1.2**, not the pin. The pinned **2.0.32** was installed into a throwaway dir *outside the repo* (`%LOCALAPPDATA%\Temp\opencode\spk5-cli`) with `npm install @opencode/cli@2.0.32`; npm's allowScripts blocked the postinstall, so it was run manually (`node …\@opencode\cli\postinstall.mjs`), which hard-links `opencode.exe` from the local `@opencode/cli-windows-x64` platform package (no network) — the same allowScripts fix SPK-1 documented for spec §18.2. `--version` → `opencode v2.0.32`. Both probes resolve the binary as `AIKA_E2E_OPENCODE_EXE` first, then that vendor dir; the dead spk-1 path is not referenced. Runs used `opencode run --standalone` (the `opencode models` preflight subcommand was abandoned because 2.0.32 manages a background service on fixed port 45278, which the user's own OpenCode session occupies — never touched again).

## Results

| # | Question | Result | Marker |
|---|---|---|---|
| P-1 | Does OpenCode's shell tool see the server's environment? | P-1 VERDICT: the shell DOES see the server environment — the key must never be in an environment. | [V] |
| P-2 | Does `options.headers` reach the request for every AI SDK package in the catalog? | P-2 VERDICT: every probed package forwards options.headers. | [V] |

Verbatim verdict lines, as printed by the probes:

- `P-1 VERDICT: the shell DOES see the server environment — the key must never be in an environment.`
- `P-2 VERDICT: every probed package forwards options.headers.`

Full per-package OK/MISS lines from P-2:

```
OK   @ai-sdk/openai-compatible -> /chat/completions
OK   @ai-sdk/anthropic -> /messages
OK   @ai-sdk/google -> /models/m1:streamGenerateContent?alt=sse
OK   @ai-sdk/openai -> /responses
```

Supporting detail:

- **P-1** (`probe-env.mjs`): the OpenCode process env carries a canary dummy (`AIK_CANARY_ENV=aik-canary-7f3d9a2b`) into an isolated sandbox (all XDG/HOME/APPDATA/LOCALAPPDATA/TEMP under the OS temp dir; cwd a temp work dir). A scripted local model mock issues the shell tool call `echo $AIK_CANARY_ENV`; the tool ran (`exit=0`, 3 model rounds) and its stdout was the canary verbatim: probe log shows `"toolCommand":"echo $AIK_CANARY_ENV","toolResult":"aik-canary-7f3d9a2b\n"`, and the session transcript printed `$ echo $AIK_CANARY_ENV` → `aik-canary-7f3d9a2b` → `TOOL-ECHO-RESULT: aik-canary-7f3d9a2b`. The canary appears nowhere in the config, so it can only have travelled through the server's environment.
- **P-2** (`probe-headers.mjs`): for each of the four catalog packages a fresh sandbox config sets `optionsHeaders`-equivalent `options: { baseURL: http://127.0.0.1:<port>, apiKey: 'local-token', headers: { 'x-aik-provider': <pkg> } }`; the local upstream records every request. All four forwarded the custom header on their first upstream request (`x-aik-provider` present). Run exit codes (`0/1/…killed-after-9-requests/1`) reflect the mock's response not matching each package's protocol — irrelevant to this probe, since the request was observed before any response handling; header forwarding is what it measures.

## Deviations from the plan's probe code (and why)

1. **Binary location/resolution** — see provenance above; the plan's `spikes/spk-1` path is dead.
2. **Deterministic scripted model mock** — the plan pointed the provider `baseURL` at `http://127.0.0.1:9/v1` (nothing listens there), so the agent could never run and the verdict would have been a false "does NOT see". Instead each probe serves a tiny scripted OpenAI-compatible mock (SSE shapes copied from the repo-verified `spikes/shared/mock-llm.mjs`): P-1's script returns the exact shell tool call, then quotes the tool result; P-2's mock records the request and answers `pong`. No real LLM and no built-in free gateway is involved.
3. **Permissions/agent config shape** — the plan's `agent` (singular) + `permission: { bash: { 'echo *': 'allow' } }` does not survive 2.0.32: preflight showed the `agent` key being ignored (`--agent prober` silently fell back to the default `build` agent), and the object-form `bash` key is the legacy alias (SPK-1 correction 5). Used the SPK-1-verified v2 shapes instead: `agents` (plural) with per-agent `permissions: [{ action: 'shell', resource: 'echo *', effect: 'allow' }]`, `system` prompt text, `tools` limited to the six real tool names, and model `probe/probe-model`. The plan's provider shape (`provider: { npm, options, models }`) **was** accepted and kept. `--auto` and `-m probe/probe-model` were kept/added as a model pin; with the explicit allow rules the tool also runs without `--auto` (verified in preflight).
4. **Stronger process isolation than the plan's env** — also redirected `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP` and `OPENCODE_CONFIG_DIR` to the sandbox, set `OPENCODE_DISABLE_PROJECT_CONFIG/CLAUDE_CODE/FILEWATCHER=1`, and pinned the shell via `OPENCODE_GIT_BASH_PATH` plus the config's top-level `shell` key (SPK-1 finding 4) so `echo $AIK_CANARY_ENV` is bash on Windows. This implements the SPK-5 hard rule (never read the user's real OpenCode home; no real credentials were read, printed, or exported anywhere in this spike).
5. **P-2 stream-aware responses** — the plan's mock always returned a single JSON body; the requested bodies ask for SSE (`stream: true`), so the mock answers SSE in that case (copied chunk shape from `mock-llm.mjs`) to avoid response-parse noise; the recorded request headers are unaffected.

## Consequence for the design

- P-1 the shell DOES see the server environment → the provider key is never placed in an environment; it lives only in the vault and in the gateway's in-flight memory.
- P-2 every probed package forwards options.headers → the gateway routes by the `x-aik-provider` header when present and falls back to resolving the provider from the requested model.
