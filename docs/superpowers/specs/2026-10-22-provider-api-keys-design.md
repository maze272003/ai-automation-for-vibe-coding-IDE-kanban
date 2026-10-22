# Provider API Keys & Model Gateway (PK-1…PK-8) Design Specification

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Status** | Approved |
| **Stories** | `PK-1` (Catalog), `PK-2` (Registry & Vault), `PK-3` (Model Gateway), `PK-4` (OpenCode Configuration), `PK-5` (Settings UI), `PK-6` (Default Model & Routing), `PK-7` (Failure Behaviour), `PK-8` (Security Boundary) |
| **Parent Spec** | `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` §9, §15.2, §18.4, §18.7 |
| **Scope** | **Managed mode only.** Personal mode is unchanged. |
| **Decision log** | Provider list is a curated shortlist + a custom OpenAI-compatible endpoint; keys are stored in Windows Credential Manager; the key reaches the model **only** through a loopback gateway; the first version supports every provider family in the catalog (OpenAI-compatible, Anthropic-native, Google-native, local). |

---

## 1. Goal and Value

Let the user connect **any** model provider the app's OpenCode runtime can speak by
**picking a provider and typing an API key** — no base URLs, no config files, no CLI
login, no environment variables for the user to set.

Today the only ways to give the app a model are the free OpenCode gateway (an OAuth
sign-in that only exposes a handful of free models) and personal mode (which borrows the
user's own `opencode` CLI and therefore gives up the app's isolation). A user holding an
OpenAI, Anthropic, Gemini, GLM, z.ai, OpenRouter or Groq key has no way to use it.

The design has one non-negotiable property:

> **The provider API key never enters the OpenCode process, the database, a log line, a
> config file, or the renderer.** OpenCode talks to a loopback gateway; the gateway
> swaps in the real key at the last moment.

That is why this is a gateway and not an environment variable: OpenCode's shell tool
runs commands from arbitrary repositories, and a key sitting in the OpenCode process
environment is readable by any of them (the orchestrator already strips provider
environment variables from *check* processes for exactly this reason —
`apps/orchestrator/src/checks/run.ts`).

---

## 2. Evidence

All probes were run on 2026-10-22 against the pinned **OpenCode 2.0.32** binary
(`@opencode/cli@2.0.32`, the same build the app installs) with an isolated
`XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` and a local
mock provider that logged every request. Marker **[V]** = verified by direct
observation.

| # | Question | Result | Marker |
|---|---|---|---|
| 1 | Can OpenCode 2.0.32 be given a provider without any CLI login? | **Yes.** With `OPENAI_API_KEY` set in the server process environment, `GET /api/provider` and `GET /api/model` expose the `openai` provider and its models. Verified identically for `ANTHROPIC_API_KEY` → `anthropic`, `GROQ_API_KEY` → `groq`, `OPENROUTER_API_KEY` → `openrouter`. The provider is picked up **only at server start**, so a new key requires a server restart. | [V] |
| 2 | Does an environment-variable key reach the agent's shell? | OpenCode spawns shell commands from the server's own environment, so a key in that environment is readable by repository code. This is why the key must not be in the environment. | [V] (by inspection of the isolation design; see `checks/run.ts` env stripping) |
| 3 | What path does an OpenAI-compatible provider receive? | `POST /chat/completions` — **no** `/v1` prefix. The version prefix lives in the provider's base URL, not in the request path. | [V] |
| 4 | What path does the Anthropic-native provider receive? | `POST /messages`, with headers `x-api-key`, `anthropic-version`, `anthropic-beta`. | [V] |
| 5 | What path does the Google-native provider receive? | `POST /models/{modelId}:streamGenerateContent?alt=sse`, with header `x-goog-api-key`. | [V] |
| 6 | Are custom headers passed through to the provider request? | **Yes.** `options.headers` in a custom provider config arrives on the outgoing request (`x-aik-provider` was observed on every probe). | [V] |
| 7 | Is the model id in the request body the plain upstream id? | **Yes** — the body carried `"model":"m1"`, the id exactly as declared in the provider config. No namespacing is needed. | [V] |
| 8 | Which upstream catalog supplies per-provider metadata? | `https://models.dev/api.json` — 232 providers, each with `npm` (the AI SDK package), `api` (base URL), `env` (variable names), `doc`, and per-model `limit` (context/output) and `cost`. 207 providers carry an explicit base URL; 25 do not (the well-known native APIs). | [V] |
| 9 | Where does OpenCode keep credentials? | `opencode auth list` reports "No authenticated integrations" for an isolated data directory even when `auth.json` is planted there; the environment-variable path (#1) is the one that works. OpenCode 2.x also ships `auth import`/`auth export`, but their JSON shape was not established, so **this design does not depend on them**. | [V] |
| 10 | Which config shape does 2.0.32 accept? | **Both** `provider`/`npm`/`options` and the older `providers`/`package`/`settings` produced a working custom provider. This design standardises on `provider`/`npm`/`options`, which is the shape models.dev's `npm` field maps onto. | [V] |

---

## 3. Requirements & Acceptance Criteria

### PK-1: Provider catalog

1. **Source.** The catalog is derived from `https://models.dev/api.json`, the same
   upstream OpenCode itself uses, so the app and OpenCode agree on model ids, packages
   and limits.
2. **Generation.** `packages/providers/scripts/refresh-catalog.ts` downloads the catalog
   and writes `packages/providers/src/catalog.data.ts`. The generated file carries a
   `generatedAt` timestamp and the source checksum. Generation is an explicit
   `npm run catalog:refresh`; the app never fetches the catalog at runtime.
3. **Content.** Each provider entry contains:
   `id`, `label`, `npm`, `baseUrl`, `auth` (`none` | `bearer` | `x-api-key` |
   `x-goog-api-key` | `api-key`), `env` (the upstream variable names, for display and
   for the "wrong key" hint), `doc`, `costClass`, `dataUse`, and `models[]`
   (`id`, `name`, `contextLimit`, `outputLimit`, `inputCost`, `outputCost`,
   `toolCall`, `reasoning`).
4. **Overridden base URLs.** The 25 providers that models.dev lists without an explicit
   base URL get a hand-verified base in `packages/providers/src/catalog.overrides.ts`,
   each with a comment naming the source document.
5. **Local providers.** `ollama` (`http://127.0.0.1:11434/v1`) and `lmstudio`
   (`http://127.0.0.1:1234/v1`) are catalog entries with `auth: 'none'`. Local
   providers need no key; the key field is optional for them.
6. **Custom endpoint.** The catalog contains one built-in entry `custom` with
   `auth: 'bearer'` and an empty base URL. Choosing it exposes a **base URL** field
   alongside the key field. The base URL must be an `http(s)` URL and is stored on the
   provider row.
7. **Featured list.** The catalog marks a *featured* subset (OpenAI, Anthropic,
   Google, z.ai, Zhipu/GLM, z.ai Coding Plan, OpenRouter, Groq, DeepSeek, Mistral,
   xAI, Together, Moonshot/Kimi, Qwen, Fireworks, Perplexity, NVIDIA, Cerebras,
   LM Studio, Ollama). The UI shows it first; the remaining providers are reachable
   through search.
8. **Data-use labels.** `dataUse` is `no_training` for the featured providers whose
   terms were read, and `unknown` for the long tail. `unknown` is displayed as
   "data use not verified" and is treated as *may train* (parent spec D-5).

### PK-2: Provider registry & credential vault

1. **Registry.** The orchestrator owns the registry. A connected provider is a row in
   `providers` and its models are rows in `model_profiles`:

   | Column | Value |
   |---|---|
   | `preset_key` | the catalog id (`zai`, `anthropic`, `custom`, …) |
   | `name` | the catalog id — also the virtual OpenCode provider id |
   | `kind` | `openai_compatible` \| `anthropic` \| `google` \| `ollama` — the protocol family, **not** the preset. The `custom` preset is `openai_compatible`. |
   | `base_url` | the upstream base URL from the catalog (or the user's, for `custom`) |
   | `key_ref` | `keyring:provider/<provider id>` — a reference, never a secret |
   | `cost_class` | `local` \| `free` \| `free_limited` \| `paid_flat` \| `paid_metered` |
   | `data_use` | `no_training` \| `may_train` \| `unknown` |
   | `enabled` | `true` while connected |

   `kind` is a plain `text` column with no SQL `CHECK` constraint, so widening the
   TypeScript union needs **no migration**.
2. **Vault.** The API key is stored in the operating system's credential store through
   `@napi-rs/keyring` under the service `AiKanban/provider` and the account
   `<provider id>`. The key is **never** written to the database, a file, a log, or an
   IPC payload. The vault has an in-memory implementation for tests, mirroring
   `MemoryCredentialStore` in `apps/orchestrator/src/github/credentials.ts`.
3. **Add.** `POST /api/providers` with `{ providerId, apiKey?, baseUrl? }`:
   1. validates the request (unknown provider → `400`; a key required unless the
      provider's `auth` is `none`; a base URL required for `custom`);
   2. writes the key to the vault;
   3. writes the `providers` row and the `model_profiles` rows (one per catalog model
      of that provider, with the catalog's context/output limits);
   4. returns the provider list **without** the key.
4. **Remove.** `DELETE /api/providers/:id` deletes the vault entry, the `providers` row
   and its `model_profiles` rows, and clears the default model if it pointed at one of
   them.
5. **Listing.** `GET /api/providers` returns, for every catalog provider, whether it is
   connected, plus the connected providers' models. It never returns key material.
6. **Re-connect.** Connecting a provider that is already connected replaces the vault
   entry and refreshes the rows in place (no duplicate rows).

### PK-3: Model gateway

1. **Placement.** The gateway is a loopback HTTP listener started by the **orchestrator**
   on `127.0.0.1` with a random free port (parent spec §18.7).
2. **Authentication.** The gateway accepts a per-app-run **gateway token** in any of
   `Authorization: Bearer <token>`, `x-api-key: <token>`, `x-goog-api-key: <token>` or
   `?key=<token>` — whichever the AI SDK package of that provider flavour uses
   (evidence #3–#5). A request without the token is rejected with `401` and no
   upstream call is made. The gateway token is **not** accepted by any orchestrator
   API route, and the orchestrator API token is **not** accepted by the gateway.
3. **Routing.** The target provider is taken from the `x-aik-provider` request header
   (evidence #6). If the header is absent, the gateway falls back to resolving the
   provider from the requested model: the `model` field of the request body when the
   body has one, otherwise the `/models/{modelId}` segment of the request path (the
   Google flavour carries the model in the path and not in the body — evidence #5).
   The gateway then verifies that the requested model belongs to that provider's
   enabled `model_profiles`; otherwise it answers `400` and makes no upstream call.
4. **Forwarding.** The upstream URL is **`<provider.baseUrl>` + the incoming request
   path and query** (evidence #3–#5: the version prefix belongs to the base URL, and
   the model id in the path is already the upstream id). The gateway:
   - strips `authorization`, `x-api-key` and `x-goog-api-key` from the incoming
     request;
   - injects the upstream credential per the provider's `auth` flavour
     (`bearer` → `Authorization: Bearer <key>`; `x-api-key` → `x-api-key: <key>`;
     `x-goog-api-key` → `x-goog-api-key: <key>`; `api-key` → `api-key: <key>`;
     `none` → a fixed non-secret placeholder);
   - forwards every other header unchanged (including `anthropic-version` and
     `anthropic-beta`);
   - streams the upstream response body back **unchanged**, preserving the
     `content-type` and the status code. Streaming responses are piped, never buffered.
5. **No silent fallback.** If the upstream call fails, the gateway returns the
   upstream status to OpenCode. It never retries against a different provider
   (parent spec D-2). Retry/backoff policy belongs to the orchestrator (PK-7).
6. **No secret in the gateway.** The gateway never logs the key, the incoming
   `Authorization`/`x-api-key`/`x-goog-api-key` values, or the upstream response body
   verbatim. Error details returned to the caller pass through the existing redactor
   (`apps/orchestrator/src/secrets/redactor.ts`).
7. **Rejection of unknown providers.** A request naming a provider that is not
   connected (or whose vault entry has gone) is answered `401` with
   `{"error":{"code":"PROVIDER_NOT_CONNECTED"}}`. The gateway never falls back to the
   built-in free OpenCode gateway.

### PK-4: OpenCode configuration

1. **Virtual providers.** For every connected provider, the desktop generates one
   OpenCode provider entry that keeps the upstream's own npm package and points at the
   gateway:

   ```jsonc
   "provider": {
     "zai": {
       "npm": "@ai-sdk/openai-compatible",
       "options": {
         "baseURL": "http://127.0.0.1:53123",     // the gateway
         "apiKey":  "<gateway token>",            // NOT the provider key
         "headers": { "x-aik-provider": "zai" }   // routing header
       },
       "models": {
         "glm-4.6": { "name": "GLM 4.6", "limit": { "context": 200000, "output": 32768 } }
       }
     }
   }
   ```

   The virtual provider's id equals the upstream provider id, so OpenCode's model
   reference `{ providerID: "zai", id: "glm-4.6" }` is stable and meaningful.
2. **Model limits.** Every declared model carries the catalog's `contextLimit` and
   `outputLimit`, so OpenCode does not fall back to a default 200k context
   (parent spec §18.4).
3. **The provider key is not in the configuration.** The configuration contains the
   *gateway* token only. A test asserts that no `provider.*.options.apiKey` value
   equals any vault key.
4. **Generation and restart.** The configuration is generated when the isolated
   OpenCode server starts. The desktop restarts that server when the connected
   provider set changes, so newly connected providers appear in the model list without
   an app restart.
5. **Shape.** The generated configuration uses the `provider` / `npm` / `options`
   shape (evidence #10). The existing E2E mock entry is migrated to the same shape.
6. **Isolation is preserved.** The managed server keeps its redirected `HOME`, XDG
   roots, `OPENCODE_DB`, disabled project/Claude-Code/file-watcher integrations and
   its per-start password.
7. **Who holds the gateway token.** The desktop main process (which generates it),
   the orchestrator (which authenticates against it), and the isolated OpenCode
   server (which presents it, through its generated configuration). It is **not**
   exposed to the renderer, the database, any file on disk, or any log line. Its
   blast radius is model quota, not provider access — see PK-8.

### PK-5: Settings UI

1. **A dedicated "Providers" card** in `apps/ui/src/routes/settings.tsx`, next to the
   existing "Default model" card.
2. **Managed mode only.** In personal mode the card shows a single explanatory line —
   "Personal mode uses your own OpenCode CLI and its credentials" — and no key fields.
3. **The picker** shows a search box, the featured providers, and the full catalog
   behind the search. Each row shows the label, the cost class and the data-use label.
4. **Connecting** expands the row into a masked key field (and a base URL field for
   `custom` only). The key field is the only required input for a hosted provider.
5. **The connected state** shows a "Connected" badge, the number of unlocked models,
   a **Test** button and a **Remove** button. A provider whose last test failed with
   an auth error shows "Key rejected".
6. **Test** performs one minimal, non-streaming completion request through the
   gateway, using the provider's first featured model, and reports success or the
   provider's own error message, redacted. It is a real (billed) request and the
   button is labelled accordingly.
7. **The renderer never receives key material.** The key is posted once to the
   orchestrator through the IPC bridge and is never returned by any endpoint. The key
   input is cleared after a successful connect.
8. **Accessibility.** The picker is a list of buttons with `aria-expanded`; the key
   field has a visible label; the connected badge is not colour-only (it carries
   text).

### PK-6: Default model & routing

1. **Persistence.** The chosen default model is stored in `app_settings` under
   `default_model` as `{ providerId, modelId }`, not only in `localStorage` as it is
   today, so the orchestrator can read it.
2. **Resolution.** The orchestrator reads `app_settings.default_model` when it builds
   the agent runtime and passes it to `OpenCodeRuntime` as `defaultModel`.
   `OpenCodeRuntime.resolveModel()` returns that model first, then falls back to
   today's behaviour (the first non-`opencode`, non-`free` model reported by
   `/api/model`).
3. **The picker lists only connected providers' models**, each with its context limit
   and price. A model from a provider that has been removed is cleared from
   `app_settings`.
4. **Per-role routes are out of scope.** The `role_routes` table stays unused in this
   version; every role uses the default model. The data model already supports
   per-role routing later.

### PK-7: Failure behaviour

| Situation | Behaviour |
|---|---|
| Upstream `401`/`403` | The run ends `BLOCKED(auth)`; the provider is flagged "Key rejected" in the UI; re-entering the key clears the flag. |
| Upstream `429` | The run ends `BLOCKED(quota)` with the existing recovery hint (`packages/contracts/src/hints.ts`). The provider's `quota_state` records the exhaustion. |
| Upstream `5xx` or timeout | Two retries with backoff, then `BLOCKED(provider_down)`. |
| Prompt exceeds the model's context | `BLOCKED(model_limit)`, using the catalog's `contextLimit`. |
| The provider's model id no longer exists upstream | The upstream `404` is surfaced as `BLOCKED(provider_down)` with the upstream detail. |
| The orchestrator (and with it the gateway) restarts | The desktop learns the new gateway port from the orchestrator's `ready` message and restarts the isolated OpenCode server so its configuration matches. |
| No provider connected | Unchanged behaviour: the built-in free OpenCode gateway stays available and the existing sign-in card still works. |

### PK-8: Security boundary

1. **Three trust boundaries, three tokens.** The renderer holds no token. The
   orchestrator API token authorises the renderer through the IPC bridge. The gateway
   token authorises the model proxy only. A gateway token cannot call any orchestrator
   endpoint; an orchestrator API token cannot call the gateway.
2. **The provider key exists in exactly two places:** the Windows Credential Manager
   entry, and the gateway process's memory while it is serving a request.
3. **The key never reaches** the OpenCode process, the OpenCode configuration, the
   database, a log line, a file in the data directory, an IPC payload, the renderer, or
   a test artefact.
4. **No provider key in check subprocesses.** The orchestrator's check runner already
   strips provider variables from the environment it hands to check processes. No
   provider key is ever in any environment in the first place, and the gateway token
   is not present in the orchestrator's or the check runner's environment either — it
   reaches OpenCode only through the generated configuration, and it is not a
   provider credential.
5. **The gateway token is not a provider credential.** It is a per-app-run random
   value; leaking it grants model quota use, not provider access. The upstream key is
   still unreachable from it.
6. **Tests never touch a real provider or a real key.** Every test uses the mock
   upstream and dummy keys, and asserts the *absence* of key material in every
   persisted and logged artefact.

---

## 4. Architecture

### 4.1 Component map

```
┌─ Renderer (apps/ui) ─────────────────┐
│ Settings ▸ Providers card            │  picker + masked key field
└──────────────┬───────────────────────┘
               │ window.api.request → IPC bridge (renderer holds no token)
┌──────────────▼───────────────────────┐        ┌──────────────────────────────────────┐
│ Desktop main (Electron)              │        │ Orchestrator (utility process)        │
│  • owns the isolated OpenCode server │        │  • provider registry  (SQLite)        │
│  • generates OPENCODE_CONFIG_CONTENT │◀──────▶│  • credential vault  (Win Cred Mgr)   │
│  • holds the gateway token           │        │  • model gateway    (127.0.0.1:port) │
└──────────────┬───────────────────────┘        └───────────┬──────────────────────────┘
               │ POST /chat/completions                     │ reads the key from the vault
               │ Authorization: Bearer <gateway token>       │ injects the real key
               │ x-aik-provider: zai                        ▼
               └────────────────────────▶  https://api.z.ai/api/paas/v4/chat/completions
```

### 4.2 Process plumbing

The desktop and the orchestrator already talk over the Electron `utilityProcess`
message channel (`apps/desktop/src/main/index.ts` → `apps/orchestrator/src/main.ts`).
Two fields are added:

| Direction | Message | Field |
|---|---|---|
| desktop → orchestrator | `init` | `gatewayToken` — the per-app-run token the gateway authenticates against |
| orchestrator → desktop | `ready` | `gatewayPort` — the port the gateway bound |

The desktop starts the isolated OpenCode server lazily; before generating its
configuration it needs the gateway port, so it waits for the `ready` message (bounded
by a timeout, after which the model list reports that the orchestrator is not
running). When the orchestrator restarts and reports a different `gatewayPort`, the
desktop restarts the isolated OpenCode server so that its configuration matches the
new gateway.

### 4.3 New and changed files

| Path | Kind | Responsibility |
|---|---|---|
| `packages/providers/package.json` | new | Workspace package `@aik/providers` |
| `packages/providers/src/catalog.data.ts` | new (generated) | The catalog, generated from models.dev |
| `packages/providers/src/catalog.overrides.ts` | new | Hand-verified base URLs and local entries |
| `packages/providers/src/index.ts` | new | Catalog types, `findProvider`, `featured` list |
| `packages/providers/scripts/refresh-catalog.ts` | new | `npm run catalog:refresh` |
| `apps/orchestrator/src/providers/service.ts` | new | Registry: connect, remove, list, model rows |
| `apps/orchestrator/src/providers/vault.ts` | new | `@napi-rs/keyring` vault + in-memory test vault |
| `apps/orchestrator/src/gateway/server.ts` | new | The loopback gateway |
| `apps/orchestrator/src/gateway/upstream.ts` | new | URL/auth rewriting per flavour |
| `apps/orchestrator/src/api/routes/providers.ts` | new | `GET/POST/DELETE /api/providers`, test route |
| `apps/orchestrator/src/agents/runtime.ts` | changed | `resolveModel()` honours `app_settings.default_model` |
| `apps/orchestrator/src/app.ts` | changed | Start the gateway; pass the gateway token |
| `apps/desktop/src/main/opencode-server.ts` | changed | Generate the virtual providers in the config |
| `apps/desktop/src/main/index.ts` | changed | Generate and pass the gateway token at init |
| `apps/ui/src/components/settings/providers-card.tsx` | new | The Providers card |
| `apps/ui/src/routes/settings.tsx` | changed | Mount the card; default-model picker uses connected models |
| `packages/contracts/src/providers.ts` | new | Shared DTOs (no key material) |

### 4.4 Orchestrator API

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/providers` | — | `{ providers: ProviderDTO[], connected: string[] }` — never key material |
| `POST /api/providers` | `{ providerId, apiKey?, baseUrl? }` | `{ ok: true, provider: ProviderDTO }` |
| `DELETE /api/providers/:id` | — | `{ ok: true }` |
| `POST /api/providers/:id/test` | — | `{ ok: true }` or `{ ok: false, error }` |
| `GET /api/settings/default-model` | — | `{ providerId, modelId } \| null` |
| `PUT /api/settings/default-model` | `{ providerId, modelId }` | `{ ok: true }` |

`ProviderDTO` = `{ id, label, kind, baseUrl, connected, costClass, dataUse, doc, env[],
models: [{ id, name, contextLimit, outputLimit, inputCost, outputCost }] }`.

### 4.5 Data flow — connecting a provider

1. Renderer → IPC bridge → `POST /api/providers` `{ providerId, apiKey }`.
2. The orchestrator validates the request against the catalog.
3. The orchestrator writes the key to the vault (`AiKanban/provider/<id>`).
4. The orchestrator writes the `providers` row and one `model_profiles` row per
   catalog model.
5. The orchestrator returns the provider DTO.
6. The renderer refreshes the model list; the desktop restarts the isolated OpenCode
   server so the new virtual provider appears in `/api/model`.

### 4.6 Data flow — an agent run

1. The desktop's OpenCode server (started with the virtual-provider configuration)
   posts to `http://127.0.0.1:<gatewayPort>/chat/completions` with the gateway token
   and `x-aik-provider: <id>`.
2. The gateway authenticates the request, resolves the provider, reads the key from
   the vault, builds the upstream URL, injects the upstream credential and forwards
   the request.
3. The upstream response is streamed back to OpenCode unchanged.
4. OpenCode's session continues; the orchestrator observes the run exactly as it does
   today.

---

## 5. Data model changes

- `providers.kind` — widen the TypeScript union to
  `'openai_compatible' | 'anthropic' | 'google' | 'ollama' | 'custom'`. No SQL
  migration (the column has no `CHECK` constraint).
- `providers.key_ref` — holds `keyring:provider/<id>`.
- `model_profiles` — populated for the first time, one row per catalog model of a
  connected provider.
- `app_settings` — one new key, `default_model`, holding
  `{ providerId, modelId }`.
- No new tables.

---

## 6. Security model

| Threat | Mitigation |
|---|---|
| A repository script prints the provider key from the environment | The key is never in any environment; only the gateway token is, and it cannot reach the provider. |
| The key leaks into a log | The gateway never logs headers or bodies; upstream error details go through the redactor. |
| The key leaks into the database | Only a `key_ref` is stored. |
| The key leaks to the renderer | The key is write-only: no endpoint returns it. |
| A leaked gateway token is used to drain the user's provider quota | The token grants only the model proxy, and the upstream key never leaves the vault. Rotating the app start rotates the token. |
| A leaked gateway token is used to reach stories, GitHub or merges | The gateway token is rejected by every orchestrator API route, and the orchestrator API token is rejected by the gateway. |
| The OpenCode server is compromised | It holds the gateway token, not the provider key; the blast radius is model quota, not the provider account. |
| A provider is silently swapped for a paid one | The gateway never falls back across providers (PK-3.5, PK-3.7). |
| The user's key is written to a test artefact | Tests use dummy keys only and assert their absence in every persisted artefact (PK-8.6). |

---

## 7. Testing strategy

Nothing in the test suite opens a network connection to a real provider, and no test
uses a real key.

| Level | Subject | Assertions |
|---|---|---|
| Unit | `catalog` | The generated catalog parses; every entry has an `npm`, a base URL and at least one model; overrides cover the 25 providers models.dev leaves without a base URL; local entries exist. |
| Unit | `upstream` (URL + auth rewriting) | One case per flavour: `bearer`, `x-api-key`, `x-goog-api-key`, `api-key`, `none`; the path and query are preserved; the model id in the path is not rewritten; incoming auth headers are stripped. |
| Unit | `gateway` | The token is required; an unknown provider is rejected; a model that does not belong to the named provider is rejected; a missing vault entry is rejected; the upstream status and body are passed through. |
| Unit | `vault` | The memory vault round-trips; the keyring vault writes to the expected service/account. |
| Unit | `registry` | Connect writes the rows and the vault entry; re-connect replaces in place; remove deletes the rows and clears the default model. |
| Unit | `config generator` | The generated configuration contains one virtual provider per connected provider, with the gateway URL, the gateway token and the routing header — and **no** provider key. |
| Unit | `resolveModel` | The configured default wins; the fallback still works when it is absent. |
| Integration | gateway ↔ mock upstream | The key is injected; the incoming token is not forwarded; the SSE stream is passed through byte-for-byte; a request without the token never reaches the upstream. |
| E2E | the full chain | Connect a mock provider through the Settings UI, pick a model, run a story, and assert the story completes. |
| Security | the whole surface | The key appears in no config file, log line, database row or IPC payload; the renderer cannot obtain the gateway token; the gateway token cannot call an orchestrator route. |

Test doubles follow the repository's existing conventions: a temporary directory
helper that asserts paths are under the OS temp directory
(`apps/orchestrator/test/helpers/temp.ts`), a memory credential store, and the existing
E2E mock provider pattern.

---

## 8. Out of scope

- **Personal mode.** The new flow is managed-mode only; personal mode continues to
  use the user's own OpenCode credentials unchanged.
- **Automatic provider selection, quota routing and paid/fallback policy.** The
  gateway never falls back; per-role routing (`role_routes`) and quota-based
  failover are parent-spec work that this design deliberately does not attempt.
- **Usage and cost accounting.** `model_usage` rows are not written by this version.
- **OAuth providers** (GitHub Copilot, OpenCode accounts, ChatGPT sign-in) — these
  need an OAuth flow, not an API key.
- **Azure OpenAI and Vertex AI**, which need a resource name / project in addition
  to the key, and Amazon Bedrock, which needs AWS credentials. They remain
  reachable through the **custom** endpoint only if their protocol is
  OpenAI-compatible.
- **A live catalog refresh at runtime.** The catalog is generated on demand by a
  script, not fetched by the app.

---

## 9. Decisions and deviations from the parent spec

| # | Decision | Reason |
|---|---|---|
| 1 | The gateway lives in the orchestrator, not the desktop. | It owns the registry, the vault and the DB, and it is where parent spec §18.7 places it. The desktop only needs the gateway's URL and token, both of which it already controls or learns from the `ready` message. |
| 2 | The gateway token is generated per app run, not per OpenCode start. | Parent spec §18.7 rotates it per OpenCode start. The desktop cannot hand a fresh token to the already-running gateway without a round trip on every server restart; rotating per app run is simpler and the token never outlives the app. The token is still absent from the provider's reach. |
| 3 | The provider key is **not** placed in the OpenCode environment. | Evidence #2. The environment is inherited by every shell command the coding agent runs. |
| 4 | One virtual OpenCode provider per connected upstream provider. | It keeps each provider's native npm package, so OpenCode speaks Gemini, Claude and GLM over their own protocols through one gateway. The alternative — a single OpenAI-compatible provider for everything — would require the gateway to translate three protocols. |
| 5 | The upstream base URL is verified per provider, not derived. | 25 providers have no base URL in models.dev; inventing one would be an unverified assumption, and parent spec forbids that. |
| 6 | The renderer talks to the orchestrator through the existing bridge. | No new IPC surface, and the renderer keeps holding no token. |
