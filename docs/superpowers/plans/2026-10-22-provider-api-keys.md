# Provider API Keys & Model Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user connect any model provider by picking it in Settings and typing an API key, with the key reaching the model only through a loopback gateway so it never enters the OpenCode process, the database, a log, or the renderer.

**Architecture:** The orchestrator owns a provider registry (SQLite), a credential vault (Windows Credential Manager) and a loopback **model gateway**. OpenCode is configured with one *virtual* provider per connected upstream provider; each virtual provider keeps its upstream's own AI SDK package and points at the gateway with a per-app-run gateway token. The gateway swaps in the real key at the last moment and streams the response back unchanged.

**Tech Stack:** TypeScript 6.0.3, Node 24, Electron 44, Fastify 5, Drizzle ORM 0.45.4 + better-sqlite3 13, `@napi-rs/keyring` 2.1.1, zod 4.6.7, React 19 + Tailwind 4 (renderer), vitest 5, Playwright 1.64 (E2E).

**Spec:** `docs/superpowers/specs/2026-10-22-provider-api-keys-design.md` (PK-1…PK-8)

---

## Global Constraints

- Dependencies use **exact versions only** (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`, which asserts paths are under the OS temp directory.
- **Never log or persist secrets.** Persisted process/provider output always goes through the redactor (`apps/orchestrator/src/secrets/redactor.ts`).
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly.
- Code under `spikes/` is throwaway; **never import it**. (Spawning `spikes/shared/mock-llm.mjs` as a child process is allowed — the E2E fixture already does it.)
- **The provider API key must never appear** in the OpenCode configuration, the database, a log line, a file in the data directory, an IPC payload, the renderer, or a test artefact. Only the vault entry and the gateway's in-flight memory may hold it.
- The **gateway token** and the **orchestrator API token** are different values with different powers: the gateway token reaches only the model proxy; the API token reaches only the orchestrator API. Neither is accepted by the other.
- The gateway **never falls back** to another provider and never falls back to the built-in free OpenCode gateway (parent spec D-2).
- Renderer → orchestrator calls go through the existing IPC bridge (`window.api.request`); the renderer holds no token. Orchestrator route paths are **root-relative** (`/providers`, not `/api/providers`), matching the existing `/github/settings` and `/stories`.
- New orchestrator mutating routes use the `mutation()` helper, which requires an `Idempotency-Key` UUID header.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/providers/src/types.ts` | `CatalogProvider`, `CatalogModel`, `AuthFlavour`, `ProviderProtocol`, `CostClass`, `DataUse` |
| `packages/providers/src/catalog.data.ts` | **Generated** catalog payload from models.dev (committed) |
| `packages/providers/src/catalog.overrides.ts` | Hand-verified base URLs, protocol map, unsupported list, featured list, local entries |
| `packages/providers/src/index.ts` | Merges data + overrides into the catalog; `findProvider`, `featuredProviders`, `searchProviders` |
| `packages/providers/scripts/refresh-catalog.ts` | Downloads models.dev and regenerates `catalog.data.ts` |
| `packages/providers/test/catalog.test.ts` | Offline tests over a fixture payload |
| `packages/providers/test/fixtures/models-dev.sample.json` | Small hand-written models.dev-shaped fixture |
| `apps/orchestrator/src/providers/vault.ts` | `ProviderVault` interface, `MemoryProviderVault`, `KeyringProviderVault` |
| `apps/orchestrator/src/providers/service.ts` | `ProviderService`: connect / remove / list, model rows, default model |
| `apps/orchestrator/src/gateway/upstream.ts` | Pure URL + auth rewriting per provider flavour |
| `apps/orchestrator/src/gateway/server.ts` | The loopback gateway listener |
| `apps/orchestrator/src/gateway/failure.ts` | Builds and parses the `[aik-provider-error]` marker |
| `apps/orchestrator/src/api/routes/providers.ts` | `/providers`, `/settings/default-model` |
| `packages/contracts/src/providers.ts` | Provider DTOs, zod request schemas, provider-failure marker helpers |
| `apps/desktop/src/main/opencode-config.ts` | Pure builder for the virtual-provider config fragment |
| `apps/desktop/src/main/gateway-context.ts` | Holds the gateway URL/token and the connected provider list for the main process |
| `apps/ui/src/components/settings/providers-card.tsx` | The Providers card |
| `spikes/spk-5/` | Throwaway probe code for P-1 and P-2 (never imported) |
| `docs/superpowers/spikes/SPK-5.md` | The P-1/P-2 evidence |

---

### Task 1: Probes P-1 and P-2 (SPK-5)

The whole design rests on two unverified facts. Settle them before writing production code.

**Files:**
- Create: `spikes/spk-5/probe-env.mjs` (throwaway)
- Create: `spikes/spk-5/probe-headers.mjs` (throwaway)
- Create: `docs/superpowers/spikes/SPK-5.md`

**Interfaces:**
- Consumes: the pinned OpenCode binary at `spikes/spk-1/node_modules/@opencode/cli/bin/opencode.exe` (or `AIKA_E2E_OPENCODE_EXE`).
- Produces: a `docs/superpowers/spikes/SPK-5.md` with a **[V]** or **[U]** verdict for P-1 and P-2, and a `VERDICT:` line naming the conclusion each task must follow.

- [ ] **Step 1: Write the P-1 probe (does a shell command see the server's environment?)**

`spikes/spk-5/probe-env.mjs`:

```js
// THROWAWAY probe. Answers: does OpenCode's shell tool inherit the server's environment?
// If yes, a provider API key must NEVER be placed in the OpenCode environment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.env.AIKA_E2E_OPENCODE_EXE
  ?? path.join('spikes', 'spk-1', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk5-'));
const CANARY = 'aik-canary-7f3d9a2b';
const cfg = {
  snapshots: false,
  provider: {
    probe: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'local-token' },
      models: { 'probe-model': { name: 'Probe' } },
    },
  },
  agent: {
    prober: {
      mode: 'primary',
      model: 'probe/probe-model',
      tools: { write: false, edit: false, read: false, grep: false, glob: false, patch: false, webfetch: false, task: false },
      permission: { bash: { 'echo *': 'allow' } },
      prompt: 'Run exactly: echo $AIK_CANARY_ENV\nThen stop.',
    },
  },
};
const env = {
  ...process.env,
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
  AIK_CANARY_ENV: CANARY,
};
const out = fs.createWriteStream(path.join(root, 'out.log'));
const proc = spawn(exe, ['run', '--standalone', '--agent', 'prober', '--auto', 'run the probe'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.pipe(out);
proc.stderr.pipe(out);
const timer = setTimeout(() => proc.kill(), 120_000);
proc.on('exit', () => {
  clearTimeout(timer);
  const text = fs.readFileSync(path.join(root, 'out.log'), 'utf8');
  console.log(text.includes(CANARY)
    ? 'P-1 VERDICT: the shell DOES see the server environment — the key must never be in an environment.'
    : 'P-1 VERDICT: the shell does NOT see the server environment.');
});
```

- [ ] **Step 2: Run the P-1 probe**

Run: `node spikes/spk-5/probe-env.mjs`
Expected: a `P-1 VERDICT:` line. If the binary is missing, install it first with `npm ci` in `spikes/spk-1` and run `node node_modules/@opencode/cli/postinstall.mjs` (npm 12 blocks the postinstall; see SPK-1's install note).

- [ ] **Step 3: Write the P-2 probe (does `options.headers` reach the request for each AI SDK package?)**

`spikes/spk-5/probe-headers.mjs`:

```js
// THROWAWAY probe. Answers: does options.headers reach the upstream request for every
// AI SDK package the catalog uses? One package per protocol family is enough.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const exe = process.env.AIKA_E2E_OPENCODE_EXE
  ?? path.join('spikes', 'spk-1', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');

const PACKAGES = ['@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/openai'];

const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ pkg: req.headers['x-aik-provider'] ?? null, path: req.url, headers: Object.keys(req.headers) });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm1', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;

for (const pkg of PACKAGES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk5-h-'));
  const cfg = {
    snapshots: false,
    provider: {
      probe: {
        npm: pkg,
        options: { baseURL: `http://127.0.0.1:${port}`, apiKey: 'local-token', headers: { 'x-aik-provider': pkg } },
        models: { m1: { name: 'M1' } },
      },
    },
  };
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
  };
  const proc = spawn(exe, ['run', '--standalone', '-m', 'probe/m1', '--auto', 'hi'], { env, stdio: 'ignore' });
  await new Promise((r) => { proc.on('exit', r); setTimeout(() => { proc.kill(); r(); }, 60_000); });
}

upstream.close();
const byPkg = new Map();
for (const s of seen) if (s.pkg) byPkg.set(s.pkg, s);
for (const pkg of PACKAGES) {
  console.log(`${byPkg.has(pkg) ? 'OK  ' : 'MISS'} ${pkg}${byPkg.has(pkg) ? ` -> ${byPkg.get(pkg).path}` : ''}`);
}
console.log(byPkg.size === PACKAGES.length
  ? 'P-2 VERDICT: every probed package forwards options.headers.'
  : 'P-2 VERDICT: some packages do NOT forward options.headers — the gateway must fall back to model-id routing for those.');
```

- [ ] **Step 4: Run the P-2 probe**

Run: `node spikes/spk-5/probe-headers.mjs`
Expected: four `OK`/`MISS` lines and a `P-2 VERDICT:` line.

- [ ] **Step 5: Record the evidence**

Create `docs/superpowers/spikes/SPK-5.md`:

```markdown
# SPK-5 — Provider key isolation probes (P-1, P-2)

**Date:** 2026-10-22 · **Binary:** OpenCode 2.0.32 (pinned) · **Probes:** `spikes/spk-5/` (throwaway)

## Results

| # | Question | Result | Marker |
|---|---|---|---|
| P-1 | Does OpenCode's shell tool see the server's environment? | <the verdict line from Step 2> | [V] |
| P-2 | Does `options.headers` reach the request for every AI SDK package in the catalog? | <the verdict line from Step 4> | [V] |

## Consequence for the design

- P-1 <verdict> → the provider key is never placed in an environment; it lives only in the vault
  and in the gateway's in-flight memory.
- P-2 <verdict> → the gateway routes by the `x-aik-provider` header when present and falls back
  to resolving the provider from the requested model.
```

Fill in the two verdicts verbatim from the probe output. Do not paraphrase them.

- [ ] **Step 6: Commit**

```bash
git add spikes/spk-5 docs/superpowers/spikes/SPK-5.md
git commit -m "docs(spike): record SPK-5 provider key isolation probes"
```

---

### Task 2: The `@aik/providers` catalog package

**Files:**
- Create: `packages/providers/package.json`
- Create: `packages/providers/src/types.ts`
- Create: `packages/providers/src/catalog.overrides.ts`
- Create: `packages/providers/src/catalog.data.ts` (generated in Step 6)
- Create: `packages/providers/src/index.ts`
- Create: `packages/providers/scripts/refresh-catalog.ts`
- Create: `packages/providers/test/fixtures/models-dev.sample.json`
- Create: `packages/providers/test/catalog.test.ts`

**Interfaces:**
- Consumes: nothing (this is the first task).
- Produces:
  ```ts
  export type AuthFlavour = 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key';
  export type ProviderProtocol = 'anthropic' | 'google' | 'openai' | 'openai_compatible';
  export type CostClass = 'local' | 'free' | 'free_limited' | 'paid_flat' | 'paid_metered';
  export type DataUse = 'no_training' | 'may_train' | 'unknown';

  export interface CatalogModel {
    id: string; name: string; contextLimit: number; outputLimit: number;
    inputCost: number | null; outputCost: number | null; toolCall: boolean; reasoning: boolean;
  }
  export interface CatalogProvider {
    id: string; label: string; protocol: ProviderProtocol; npm: string; baseUrl: string;
    auth: AuthFlavour; env: string[]; doc: string | null; costClass: CostClass; dataUse: DataUse;
    featured: boolean; unsupportedReason: string | null; models: CatalogModel[];
  }

  export const CATALOG: readonly CatalogProvider[];
  export function findProvider(id: string): CatalogProvider | undefined;
  export function featuredProviders(): CatalogProvider[];
  export function searchProviders(query: string): CatalogProvider[];
  ```

- [ ] **Step 1: Create the package manifest**

`packages/providers/package.json`:

```json
{
  "name": "@aik/providers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

The root `tsconfig.json` already includes `packages/*/src` and `packages/*/test`, and the root `package.json` already lists `packages/*` as a workspace, so no other manifest changes are needed.

- [ ] **Step 2: Write the failing test**

`packages/providers/test/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CATALOG, findProvider, featuredProviders, searchProviders } from '../src/index.ts';
import { buildCatalog } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'models-dev.sample.json'), 'utf8'),
) as Record<string, unknown>;

describe('buildCatalog', () => {
  it('maps a models.dev payload into catalog providers', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: { '@ai-sdk/openai-compatible': 'openai_compatible' },
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: {},
      featured: ['mockai'],
      localEntries: {},
    });
    const provider = catalog.find((p) => p.id === 'mockai');
    expect(provider).toBeDefined();
    expect(provider?.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider?.auth).toBe('bearer');
    expect(provider?.baseUrl).toBe('https://mockai.test/v1');
    expect(provider?.models[0]).toMatchObject({ id: 'mock-model', contextLimit: 131072, outputLimit: 8192 });
  });

  it('derives the cost class from the model prices', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: { '@ai-sdk/openai-compatible': 'openai_compatible' },
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: {},
      featured: [],
      localEntries: {},
    });
    // The fixture's model costs 0.5/1.5 -> paid; the second costs 0/0 -> free_limited.
    expect(catalog.find((p) => p.id === 'mockai')?.costClass).toBe('paid_metered');
    expect(catalog.find((p) => p.id === 'freeai')?.costClass).toBe('free_limited');
  });

  it('marks a provider unsupported when its package is not in the protocol map', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: {},
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: { '@ai-sdk/openai-compatible': 'not verified' },
      featured: [],
      localEntries: {},
    });
    expect(catalog.find((p) => p.id === 'mockai')?.unsupportedReason).toBe('not verified');
  });
});

describe('the committed catalog', () => {
  it('has at least 200 providers, each with a package, a base URL and models', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(200);
    for (const p of CATALOG) {
      expect(p.id, p.id).toMatch(/^[a-z0-9._-]+$/);
      expect(p.npm.length, p.id).toBeGreaterThan(0);
      // `custom` is the escape hatch: the user supplies its base URL and models.
      if (p.id === 'custom' || p.unsupportedReason) continue;
      expect(p.baseUrl.length, p.id).toBeGreaterThan(0);
      expect(p.models.length, p.id).toBeGreaterThan(0);
    }
  });

  it('includes the featured providers and the local ones', () => {
    for (const id of ['openai', 'anthropic', 'google', 'zai', 'zhipuai', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai']) {
      expect(findProvider(id), id).toBeDefined();
    }
    expect(findProvider('ollama')?.auth).toBe('none');
    expect(findProvider('lmstudio')?.auth).toBe('none');
    expect(findProvider('custom')?.baseUrl).toBe('');
  });

  it('finds providers by search term and lists the featured ones first', () => {
    expect(searchProviders('glm').map((p) => p.id)).toContain('zhipuai');
    expect(searchProviders('zzzznotathing')).toHaveLength(0);
    const featured = featuredProviders();
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.every((p) => p.featured)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/providers/test/catalog.test.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'`.

- [ ] **Step 4: Write the types**

`packages/providers/src/types.ts`:

```ts
// packages/providers/src/types.ts — the shape of a provider the app can connect.
export type AuthFlavour = 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key';
export type ProviderProtocol = 'anthropic' | 'google' | 'openai' | 'openai_compatible';
export type CostClass = 'local' | 'free' | 'free_limited' | 'paid_flat' | 'paid_metered';
export type DataUse = 'no_training' | 'may_train' | 'unknown';

export interface CatalogModel {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  inputCost: number | null;
  outputCost: number | null;
  toolCall: boolean;
  reasoning: boolean;
}

export interface CatalogProvider {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  env: string[];
  doc: string | null;
  costClass: CostClass;
  dataUse: DataUse;
  featured: boolean;
  /** Set when the provider needs more than an API key; the UI disables it and shows the reason. */
  unsupportedReason: string | null;
  models: CatalogModel[];
}

export interface CatalogOverrides {
  /** Base URL for providers models.dev lists without one, keyed by provider id. */
  baseUrl: Record<string, string>;
  /** Which protocol an AI SDK package speaks, keyed by npm package name. */
  protocolByNpm: Record<string, ProviderProtocol>;
  /** How the gateway injects the upstream credential, keyed by protocol. */
  authByProtocol: Record<ProviderProtocol, AuthFlavour>;
  /** Packages that need more than an API key, with the reason. */
  unsupportedNpm: Record<string, string>;
  /** Provider ids shown first in the picker. */
  featured: string[];
  /** Providers that are not in models.dev at all, keyed by provider id. */
  localEntries: Record<string, LocalProviderEntry>;
}

export interface LocalProviderEntry {
  label: string;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  doc: string | null;
  models: CatalogModel[];
}
```

- [ ] **Step 5: Write the overrides**

`packages/providers/src/catalog.overrides.ts`:

```ts
// packages/providers/src/catalog.overrides.ts
// Hand-verified facts that models.dev does not carry. Every base URL below was read from
// the provider's own API documentation; the comment names the source.
import type { CatalogOverrides } from './types.ts';

export const OVERRIDES: CatalogOverrides = {
  // ── Base URLs for the 25 providers models.dev lists without one ──────────────────────
  baseUrl: {
    // https://platform.openai.com/docs/api-reference
    openai: 'https://api.openai.com/v1',
    // https://docs.anthropic.com/en/api
    anthropic: 'https://api.anthropic.com/v1',
    // https://ai.google.dev/api
    google: 'https://generativelanguage.googleapis.com/v1beta',
    // https://console.groq.com/docs/openai
    groq: 'https://api.groq.com/openai/v1',
    // https://docs.x.ai/docs/api-reference
    xai: 'https://api.x.ai/v1',
    // https://docs.mistral.ai/api
    mistral: 'https://api.mistral.ai/v1',
    // https://docs.together.ai/docs/openai-api-compatibility
    togetherai: 'https://api.together.xyz/v1',
    // https://inference-docs.cerebras.ai/api-reference
    cerebras: 'https://api.cerebras.ai/v1',
    // https://docs.perplexity.ai/api-reference
    perplexity: 'https://api.perplexity.ai',
  },

  // ── Which protocol an AI SDK package speaks ────────────────────────────────────────
  protocolByNpm: {
    '@ai-sdk/anthropic': 'anthropic',
    '@ai-sdk/google': 'google',
    '@ai-sdk/openai': 'openai',
    '@ai-sdk/openai-compatible': 'openai_compatible',
    '@ai-sdk/groq': 'openai_compatible',
    '@ai-sdk/xai': 'openai_compatible',
    '@ai-sdk/mistral': 'openai_compatible',
    '@ai-sdk/togetherai': 'openai_compatible',
    '@ai-sdk/cerebras': 'openai_compatible',
    '@ai-sdk/perplexity': 'openai_compatible',
  },

  // ── How the gateway injects the upstream credential ────────────────────────────────
  authByProtocol: {
    anthropic: 'x-api-key',
    google: 'x-goog-api-key',
    openai: 'bearer',
    openai_compatible: 'bearer',
  },

  // ── Providers that need more than an API key ──────────────────────────────────────
  unsupportedNpm: {
    '@ai-sdk/azure': 'Azure needs a resource name and a deployment path, not just a key',
    '@ai-sdk/amazon-bedrock': 'Bedrock needs AWS credentials and a region',
    '@ai-sdk/google-vertex': 'Vertex AI needs a Google Cloud project',
    '@ai-sdk/google-vertex/anthropic': 'Vertex AI needs a Google Cloud project',
    '@jerome-benoit/sap-ai-provider-v2': 'SAP AI Core needs a tenant and a client id',
    '@ai-sdk/cohere': 'Cohere does not speak the OpenAI chat-completions protocol',
    '@ai-sdk/deepinfra': 'Third-party protocol not verified',
    '@ai-sdk/gateway': 'Third-party protocol not verified',
    '@aihubmix/ai-sdk-provider': 'Third-party protocol not verified',
    '@qvac/ai-sdk-provider': 'Third-party protocol not verified',
    '@saladtechnologies-oss/ai-sdk-provider': 'Third-party protocol not verified',
    'ai-gateway-provider': 'Third-party protocol not verified',
    'gitlab-ai-provider': 'Third-party protocol not verified',
    'merge-gateway-ai-sdk-provider': 'Third-party protocol not verified',
    'venice-ai-sdk-provider': 'Third-party protocol not verified',
    'watsonx-ai-provider': 'Third-party protocol not verified',
  },

  // ── Shown first in the picker ─────────────────────────────────────────────────────
  featured: [
    'openai', 'anthropic', 'google', 'zai', 'zhipuai', 'zai-coding-plan', 'openrouter',
    'groq', 'deepseek', 'mistral', 'xai', 'togetherai', 'moonshotai', 'fireworks-ai',
    'perplexity', 'nvidia', 'cerebras', 'lmstudio', 'ollama',
  ],

  // ── Providers that are not in models.dev ─────────────────────────────────────────
  localEntries: {
    // The escape hatch: any OpenAI-compatible service. Its base URL and models are
    // supplied by the user, so it has no base URL and no models of its own.
    custom: {
      label: 'Custom (OpenAI-compatible)',
      npm: '@ai-sdk/openai-compatible',
      baseUrl: '',
      auth: 'bearer',
      doc: null,
      models: [],
    },
    // https://github.com/ollama/ollama/blob/main/docs/api.md
    ollama: {
      label: 'Ollama (local)',
      npm: '@ai-sdk/openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: 'none',
      doc: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
      models: [
        { id: 'qwen3-coder', name: 'Qwen3 Coder', contextLimit: 262144, outputLimit: 32768, inputCost: null, outputCost: null, toolCall: true, reasoning: true },
        { id: 'llama3.3', name: 'Llama 3.3', contextLimit: 131072, outputLimit: 32768, inputCost: null, outputCost: null, toolCall: true, reasoning: false },
      ],
    },
  },
};
```

- [ ] **Step 6: Write the index (the merge logic)**

`packages/providers/src/index.ts`:

```ts
// packages/providers/src/index.ts — the provider catalog the app connects to.
import { OVERRIDES } from './catalog.overrides.ts';
import { RAW_CATALOG } from './catalog.data.ts';
import type { CatalogModel, CatalogOverrides, CatalogProvider, CostClass } from './types.ts';

export * from './types.ts';

interface RawModel {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
  reasoning?: boolean;
}

interface RawProvider {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models?: Record<string, RawModel>;
}

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 8_192;

function toModel(id: string, raw: RawModel): CatalogModel {
  return {
    id,
    name: raw.name ?? id,
    contextLimit: raw.limit?.context ?? DEFAULT_CONTEXT,
    outputLimit: raw.limit?.output ?? DEFAULT_OUTPUT,
    inputCost: typeof raw.cost?.input === 'number' ? raw.cost.input : null,
    outputCost: typeof raw.cost?.output === 'number' ? raw.cost.output : null,
    toolCall: raw.tool_call !== false,
    reasoning: raw.reasoning === true,
  };
}

function deriveCostClass(models: CatalogModel[], local: boolean): CostClass {
  if (local) return 'local';
  if (models.length === 0) return 'paid_metered';
  const priced = models.filter((m) => m.inputCost !== null || m.outputCost !== null);
  if (priced.length === 0) return 'free_limited';
  const free = priced.filter((m) => (m.inputCost ?? 0) === 0 && (m.outputCost ?? 0) === 0);
  if (free.length === priced.length) return 'free';
  if (free.length > 0) return 'free_limited';
  return 'paid_metered';
}

export function buildCatalog(raw: Record<string, unknown>, overrides: CatalogOverrides): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, RawProvider>)) {
    const p = value ?? {};
    const npm = p.npm ?? '';
    const protocol = overrides.protocolByNpm[npm];
    const unsupportedReason = protocol ? null : (overrides.unsupportedNpm[npm] ?? 'Protocol not verified');
    const models = Object.entries(p.models ?? {}).map(([modelId, m]) => toModel(modelId, m as RawModel));
    const baseUrl = p.api ?? overrides.baseUrl[id] ?? '';
    out.push({
      id,
      label: p.name ?? id,
      protocol: protocol ?? 'openai_compatible',
      npm,
      baseUrl,
      auth: protocol ? overrides.authByProtocol[protocol] : 'bearer',
      env: p.env ?? [],
      doc: p.doc ?? null,
      costClass: deriveCostClass(models, false),
      dataUse: 'unknown',
      featured: overrides.featured.includes(id),
      unsupportedReason,
      models,
    });
  }
  for (const [id, local] of Object.entries(overrides.localEntries)) {
    out.push({
      id,
      label: local.label,
      protocol: 'openai_compatible',
      npm: local.npm,
      baseUrl: local.baseUrl,
      auth: local.auth,
      env: [],
      doc: local.doc,
      costClass: deriveCostClass(local.models, true),
      dataUse: 'no_training',
      featured: overrides.featured.includes(id),
      unsupportedReason: null,
      models: local.models,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const CATALOG: readonly CatalogProvider[] = buildCatalog(RAW_CATALOG, OVERRIDES);

export function findProvider(id: string): CatalogProvider | undefined {
  return CATALOG.find((p) => p.id === id);
}

export function featuredProviders(): CatalogProvider[] {
  return CATALOG.filter((p) => p.featured);
}

export function searchProviders(query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CATALOG];
  return CATALOG.filter(
    (p) => p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.env.some((e) => e.toLowerCase().includes(q)),
  );
}
```

- [ ] **Step 7: Write the fixture**

`packages/providers/test/fixtures/models-dev.sample.json`:

```json
{
  "mockai": {
    "id": "mockai",
    "name": "Mock AI",
    "env": ["MOCKAI_API_KEY"],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://mockai.test/v1",
    "doc": "https://mockai.test/docs",
    "models": {
      "mock-model": {
        "id": "mock-model",
        "name": "Mock Model",
        "tool_call": true,
        "reasoning": false,
        "limit": { "context": 131072, "output": 8192 },
        "cost": { "input": 0.5, "output": 1.5 }
      }
    }
  },
  "freeai": {
    "id": "freeai",
    "name": "Free AI",
    "env": ["FREEAI_API_KEY"],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://freeai.test/v1",
    "doc": "https://freeai.test/docs",
    "models": {
      "free-model": { "id": "free-model", "name": "Free Model", "limit": { "context": 65536, "output": 4096 }, "cost": { "input": 0, "output": 0 } },
      "paid-model": { "id": "paid-model", "name": "Paid Model", "limit": { "context": 65536, "output": 4096 }, "cost": { "input": 1, "output": 2 } }
    }
  },
  "nokeyai": {
    "id": "nokeyai",
    "name": "No Key AI",
    "env": [],
    "npm": "@ai-sdk/openai-compatible",
    "models": {
      "m": { "id": "m", "name": "M", "limit": { "context": 8000, "output": 1000 }, "cost": { "input": 0, "output": 0 } }
    }
  }
}
```

- [ ] **Step 8: Write the generator**

`packages/providers/scripts/refresh-catalog.ts`:

```ts
// packages/providers/scripts/refresh-catalog.ts — regenerates src/catalog.data.ts from models.dev.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = 'https://models.dev/api.json';
const OUT = path.join(import.meta.dirname, '..', 'src', 'catalog.data.ts');

interface RawProvider {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
  const payload = (await res.json()) as Record<string, RawProvider>;
  const ids = Object.keys(payload).sort();
  if (ids.length < 100) throw new Error(`models.dev returned only ${ids.length} providers — refusing to write`);
  const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const body = `// GENERATED by packages/providers/scripts/refresh-catalog.ts — do not edit by hand.
// Source: ${SOURCE} · generatedAt: ${new Date().toISOString()} · sha256: ${checksum}
export const RAW_CATALOG: Record<string, unknown> = ${JSON.stringify(payload, null, 0)};
`;
  fs.writeFileSync(OUT, body, 'utf8');
  console.log(`Wrote ${ids.length} providers to ${path.relative(process.cwd(), OUT)} (sha256 ${checksum.slice(0, 12)})`);
}

await main();
```

- [ ] **Step 9: Run the generator**

Run: `node --experimental-strip-types packages/providers/scripts/refresh-catalog.ts`
Expected: `Wrote 232 providers to packages/providers/src/catalog.data.ts (sha256 …)`.

If the download fails, **stop and report it** — do not hand-write a catalog.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run packages/providers/test/catalog.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 11: Add the refresh script to the root manifest**

In `package.json`, add to `scripts`:

```json
"catalog:refresh": "node --experimental-strip-types packages/providers/scripts/refresh-catalog.ts"
```

- [ ] **Step 12: Verify the whole repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add packages/providers package.json
git commit -m "feat(providers): add the models.dev-backed provider catalog package"
```

---

### Task 3: The credential vault

**Files:**
- Create: `apps/orchestrator/src/providers/vault.ts`
- Create: `apps/orchestrator/test/provider-vault.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ProviderVault {
    saveKey(providerId: string, key: string): Promise<void>;
    loadKey(providerId: string): Promise<string | null>;
    deleteKey(providerId: string): Promise<void>;
  }
  export class MemoryProviderVault implements ProviderVault { /* ... */ }
  export class KeyringProviderVault implements ProviderVault { /* ... */ }
  export function createProviderVault(): ProviderVault;
  ```

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/test/provider-vault.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryProviderVault } from '../src/providers/vault.ts';

describe('MemoryProviderVault', () => {
  it('saves, loads and deletes a key per provider', async () => {
    const vault = new MemoryProviderVault();
    await vault.saveKey('zai', 'sk-dummy-zai');
    await vault.saveKey('anthropic', 'sk-dummy-anthropic');
    expect(await vault.loadKey('zai')).toBe('sk-dummy-zai');
    expect(await vault.loadKey('anthropic')).toBe('sk-dummy-anthropic');
    expect(await vault.loadKey('groq')).toBeNull();
    await vault.deleteKey('zai');
    expect(await vault.loadKey('zai')).toBeNull();
    expect(await vault.loadKey('anthropic')).toBe('sk-dummy-anthropic');
  });

  it('replaces a key instead of appending', async () => {
    const vault = new MemoryProviderVault();
    await vault.saveKey('zai', 'first');
    await vault.saveKey('zai', 'second');
    expect(await vault.loadKey('zai')).toBe('second');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/provider-vault.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/vault.ts'`.

- [ ] **Step 3: Write the implementation**

`apps/orchestrator/src/providers/vault.ts`:

```ts
// apps/orchestrator/src/providers/vault.ts — the provider API keys, in the OS credential store.
import { Entry } from '@napi-rs/keyring';

export interface ProviderVault {
  saveKey(providerId: string, key: string): Promise<void>;
  loadKey(providerId: string): Promise<string | null>;
  deleteKey(providerId: string): Promise<void>;
}

export class MemoryProviderVault implements ProviderVault {
  private readonly keys = new Map<string, string>();

  async saveKey(providerId: string, key: string): Promise<void> {
    this.keys.set(providerId, key);
  }

  async loadKey(providerId: string): Promise<string | null> {
    return this.keys.get(providerId) ?? null;
  }

  async deleteKey(providerId: string): Promise<void> {
    this.keys.delete(providerId);
  }
}

export class KeyringProviderVault implements ProviderVault {
  constructor(private readonly servicePrefix = 'AiKanban/provider') {}

  private entry(providerId: string): Entry {
    return new Entry(this.servicePrefix, providerId);
  }

  async saveKey(providerId: string, key: string): Promise<void> {
    this.entry(providerId).setPassword(key);
  }

  async loadKey(providerId: string): Promise<string | null> {
    try {
      return this.entry(providerId).getPassword() || null;
    } catch {
      return null;
    }
  }

  async deleteKey(providerId: string): Promise<void> {
    try {
      this.entry(providerId).deletePassword();
    } catch {
      // Not present — nothing to do.
    }
  }
}

export function createProviderVault(): ProviderVault {
  if (process.env.NODE_ENV === 'test' || process.env.AIK_CREDENTIAL_STORE === 'memory') {
    return new MemoryProviderVault();
  }
  return new KeyringProviderVault();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/provider-vault.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/providers/vault.ts apps/orchestrator/test/provider-vault.test.ts
git commit -m "feat(orchestrator): add the provider credential vault"
```

---

### Task 4: The provider registry

**Files:**
- Create: `apps/orchestrator/src/providers/service.ts`
- Create: `apps/orchestrator/test/provider-registry.test.ts`

**Interfaces:**
- Consumes: `ProviderVault` (Task 3), `findProvider` / `CatalogProvider` (Task 2), the drizzle `providers` and `model_profiles` tables.
- Produces:
  ```ts
  export interface ConnectedProvider {
    id: string;            // the virtual OpenCode provider id
    kind: 'openai_compatible' | 'anthropic' | 'google' | 'ollama';
    npm: string;
    baseUrl: string;
    auth: AuthFlavour;
    modelIds: string[];
  }
  export interface ProviderServiceDeps {
    db: AikDb;
    vault: ProviderVault;
    now: () => number;
    /** Discovers the model ids of a custom OpenAI-compatible endpoint. */
    discoverModels?: (baseUrl: string, key: string) => Promise<string[]>;
  }
  export class ProviderService {
    list(): ProviderDTO[];
    connect(input: { providerId: string; apiKey?: string; baseUrl?: string }): ProviderDTO;
    remove(providerId: string): void;
    getConnected(): ConnectedProvider[];
    getDefaultModel(): { providerId: string; modelId: string } | null;
    setDefaultModel(model: { providerId: string; modelId: string }): void;
    markQuotaExhausted(providerId: string, status: number, until: number | null): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/test/provider-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { modelProfiles, providers } from '@aik/db';
import { ProviderService } from '../src/providers/service.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createTestDb } from './helpers/db.ts';

const now = () => 1_700_000_000_000;

function service(overrides: Partial<ConstructorParameters<typeof ProviderService>[0]> = {}) {
  const t = createTestDb();
  const vault = new MemoryProviderVault();
  const s = new ProviderService({ db: t.db, vault, now, ...overrides });
  return { t, vault, s };
}

describe('ProviderService', () => {
  it('connects a catalog provider: vault entry, provider row and model rows', async () => {
    const { t, vault, s } = service();
    const dto = await s.connect({ providerId: 'openai', apiKey: 'sk-dummy-openai' });
    expect(dto.connected).toBe(true);
    expect(dto.id).toBe('openai');
    expect(await vault.loadKey('openai')).toBe('sk-dummy-openai');

    const rows = t.db.select().from(providers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].keyRef).toBe('keyring:provider/openai');
    expect(rows[0].baseUrl).toBe('https://api.openai.com/v1');
    const models = t.db.select().from(modelProfiles).all();
    expect(models.length).toBeGreaterThan(0);
  });

  it('never returns key material in the DTO', async () => {
    const { s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy-openai' });
    expect(JSON.stringify(s.list())).not.toContain('sk-dummy-openai');
  });

  it('rejects an unknown provider and a missing key', async () => {
    const { s } = service();
    await expect(s.connect({ providerId: 'not-a-provider', apiKey: 'x' })).rejects.toThrow(/unknown provider/i);
    await expect(s.connect({ providerId: 'openai' })).rejects.toThrow(/api key/i);
  });

  it('replaces the key and the rows when a provider is connected twice', async () => {
    const { t, vault, s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-first' });
    await s.connect({ providerId: 'openai', apiKey: 'sk-second' });
    expect(await vault.loadKey('openai')).toBe('sk-second');
    expect(t.db.select().from(providers).all()).toHaveLength(1);
  });

  it('removes a provider: vault entry, rows and the default model', async () => {
    const { t, vault, s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy' });
    s.setDefaultModel({ providerId: 'openai', modelId: 'gpt-4o' });
    s.remove('openai');
    expect(await vault.loadKey('openai')).toBeNull();
    expect(t.db.select().from(providers).all()).toHaveLength(0);
    expect(t.db.select().from(modelProfiles).all()).toHaveLength(0);
    expect(s.getDefaultModel()).toBeNull();
  });

  it('gives each custom endpoint its own id and discovers its models', async () => {
    const { s } = service({ discoverModels: async () => ['my-model-a', 'my-model-b'] });
    const a = await s.connect({ providerId: 'custom', apiKey: 'sk-dummy', baseUrl: 'http://127.0.0.1:1234/v1' });
    const b = await s.connect({ providerId: 'custom', apiKey: 'sk-dummy', baseUrl: 'http://127.0.0.1:5678/v1' });
    expect(a.connectedId).not.toBe(b.connectedId);
    expect(a.connectedId?.startsWith('custom-')).toBe(true);
    expect(s.getConnected().find((p) => p.id === a.connectedId)?.modelIds).toEqual(['my-model-a', 'my-model-b']);
  });

  it('stores and clears the default model', async () => {
    const { s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy' });
    s.setDefaultModel({ providerId: 'openai', modelId: 'gpt-4o' });
    expect(s.getDefaultModel()).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
    s.setDefaultModel(null);
    expect(s.getDefaultModel()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/provider-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/providers/service.ts'`.

- [ ] **Step 3: Read the test database helper**

Run: `cat apps/orchestrator/test/helpers/db.ts`
Expected: it exports `createTestDb()` returning `{ db, close }` and creates a fresh SQLite database under the OS temp directory. Use its real field names in the test above.

- [ ] **Step 4: Write the implementation**

`apps/orchestrator/src/providers/service.ts`:

```ts
// apps/orchestrator/src/providers/service.ts — which providers are connected, and which models they offer.
import { findProvider, type AuthFlavour, type CatalogProvider } from '@aik/providers';
import { appSettings, modelProfiles, providers, type AikDb } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import type { ProviderDTO, ProviderModelDTO } from '@aik/contracts';
import type { ProviderVault } from './vault.ts';

export type ProviderKind = 'openai_compatible' | 'anthropic' | 'google' | 'ollama';

export interface ConnectedProvider {
  id: string;
  kind: ProviderKind;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  modelIds: string[];
}

export interface ProviderServiceDeps {
  db: AikDb;
  vault: ProviderVault;
  now: () => number;
  discoverModels?: (baseUrl: string, key: string) => Promise<string[]>;
}

const DEFAULT_MODEL_KEY = 'default_model';

function kindOf(provider: CatalogProvider): ProviderKind {
  if (provider.auth === 'none') return 'ollama';
  if (provider.protocol === 'anthropic') return 'anthropic';
  if (provider.protocol === 'google') return 'google';
  return 'openai_compatible';
}

/** `http://host:port/v1` -> `host`; used to give each custom endpoint a readable id. */
function slugOf(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return host || 'endpoint';
  } catch {
    return 'endpoint';
  }
}

export class ProviderService {
  constructor(private readonly deps: ProviderServiceDeps) {}

  /** Every catalog provider, with `connected` set and the models of the connected ones. */
  list(): ProviderDTO[] {
    const rows = this.connectedRows();
    const byPreset = new Map<string, string[]>();
    for (const row of rows.values()) {
      const presetKey = row.presetKey ?? '';
      byPreset.set(presetKey, [...(byPreset.get(presetKey) ?? []), row.name]);
    }
    return CATALOG.map((p) => {
      // A catalog provider is connected when a row with its name exists. The `custom`
      // preset holds any number of endpoints, so it matches on the preset key instead.
      const matched = p.id === 'custom'
        ? (byPreset.get(p.id) ?? []).map((name) => rows.get(name)!).filter(Boolean)
        : rows.has(p.id) ? [rows.get(p.id)!] : [];
      const models: ProviderModelDTO[] = [];
      for (const row of matched) {
        for (const m of this.modelsOf(row.id)) {
          models.push({
            id: m.modelId,
            name: m.family ?? m.modelId,
            contextLimit: m.contextLimit,
            outputLimit: m.outputLimit,
            inputCost: null,
            outputCost: null,
          });
        }
      }
      return {
        id: p.id,
        label: p.label,
        kind: kindOf(p),
        npm: p.npm,
        baseUrl: p.baseUrl,
        connected: matched.length > 0,
        connectedId: matched[0]?.name ?? null,
        featured: p.featured,
        costClass: p.costClass,
        dataUse: p.dataUse,
        doc: p.doc,
        env: p.env,
        unsupportedReason: p.unsupportedReason,
        models,
      };
    });
  }

  async connect(input: { providerId: string; apiKey?: string; baseUrl?: string }): Promise<ProviderDTO> {
    const preset = CATALOG.find((p) => p.id === input.providerId);
    if (!preset) throw new Error(`Unknown provider: ${input.providerId}`);
    if (preset.unsupportedReason) throw new Error(`${preset.label} is not supported: ${preset.unsupportedReason}`);
    const needsKey = preset.auth !== 'none';
    if (needsKey && !input.apiKey) throw new Error(`An API key is required for ${preset.label}`);
    const isCustom = preset.id === 'custom';
    if (isCustom && !input.baseUrl) throw new Error('A base URL is required for a custom endpoint');
    const baseUrl = isCustom ? (input.baseUrl as string).replace(/\/+$/, '') : preset.baseUrl;
    if (isCustom && !/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must start with http:// or https://');

    const id = isCustom ? this.uniqueCustomId(baseUrl) : preset.id;
    const key = input.apiKey ?? `local-${id}`;

    await this.deps.vault.saveKey(id, key);
    this.upsertProvider(id, preset, baseUrl);
    await this.upsertModels(id, preset, isCustom, baseUrl, key);
    const dto = this.list().find((p) => (isCustom ? p.connectedId === id : p.id === id));
    if (!dto) throw new Error(`Could not store the provider ${id}`);
    return dto;
  }

  remove(providerId: string): void {
    const row = this.connectedRows().get(providerId);
    if (!row) return;
    void this.deps.vault.deleteKey(providerId);
    this.deps.db.delete(modelProfiles).where(eq(modelProfiles.providerId, row.id)).run();
    this.deps.db.delete(providers).where(eq(providers.id, row.id)).run();
    const current = this.getDefaultModel();
    if (current && current.providerId === providerId) this.setDefaultModel(null);
  }

  getConnected(): ConnectedProvider[] {
    const out: ConnectedProvider[] = [];
    for (const [id, row] of this.connectedRows()) {
      const preset = this.catalog().find((p) => p.id === row.presetKey);
      out.push({
        id,
        kind: (row.kind as ProviderKind) ?? 'openai_compatible',
        npm: preset?.npm ?? '@ai-sdk/openai-compatible',
        baseUrl: row.baseUrl,
        auth: (preset?.auth ?? 'bearer') as AuthFlavour,
        modelIds: this.modelsOf(row.id).map((m) => m.modelId),
      });
    }
    return out;
  }

  getDefaultModel(): { providerId: string; modelId: string } | null {
    const row = this.deps.db.select().from(appSettings).where(eq(appSettings.key, DEFAULT_MODEL_KEY)).get();
    if (!row) return null;
    const value = row.value as { providerId?: string; modelId?: string } | null;
    if (!value?.providerId || !value?.modelId) return null;
    return { providerId: value.providerId, modelId: value.modelId };
  }

  setDefaultModel(model: { providerId: string; modelId: string } | null): void {
    if (model === null) {
      this.deps.db.delete(appSettings).where(eq(appSettings.key, DEFAULT_MODEL_KEY)).run();
      return;
    }
    const row = this.connectedRows().get(model.providerId);
    if (!row) throw new Error(`Unknown provider: ${model.providerId}`);
    this.deps.db
      .insert(appSettings)
      .values({ key: DEFAULT_MODEL_KEY, value: model, updatedAt: new Date(this.deps.now()) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: model, updatedAt: new Date(this.deps.now()) } })
      .run();
  }

  /** Records that a provider answered 429, so the UI can say the quota is exhausted. */
  markQuotaExhausted(providerId: string, status: number, until: number | null): void {
    const row = this.connectedRows().get(providerId);
    if (!row) return;
    this.deps.db
      .update(providers)
      .set({ quotaState: { exhaustedUntil: until, lastStatus: status, remaining: null } })
      .where(eq(providers.id, row.id))
      .run();
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private connectedRows(): Map<string, typeof providers.$inferSelect> {
    const map = new Map<string, typeof providers.$inferSelect>();
    for (const row of this.deps.db.select().from(providers).all()) {
      if (row.enabled) map.set(row.name, row);
    }
    return map;
  }

  private modelsOf(providerRowId: number) {
    return this.deps.db.select().from(modelProfiles).where(eq(modelProfiles.providerId, providerRowId)).all();
  }

  private uniqueCustomId(baseUrl: string): string {
    const base = `custom-${slugOf(baseUrl)}`;
    const taken = new Set([...this.connectedRows().keys()]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private upsertProvider(id: string, preset: CatalogProvider, baseUrl: string): void {
    const existing = this.deps.db.select().from(providers).where(eq(providers.name, id)).get();
    const values = {
      presetKey: preset.id,
      name: id,
      kind: kindOf(preset),
      baseUrl,
      keyRef: `keyring:provider/${id}`,
      costClass: preset.costClass,
      dataUse: preset.dataUse,
      enabled: true,
    };
    if (existing) {
      this.deps.db.update(providers).set(values).where(eq(providers.id, existing.id)).run();
      return;
    }
    this.deps.db.insert(providers).values(values).run();
  }

  private async upsertModels(id: string, preset: CatalogProvider, isCustom: boolean, baseUrl: string, key: string): Promise<void> {
    const row = this.deps.db.select().from(providers).where(eq(providers.name, id)).get();
    if (!row) return;
    this.deps.db.delete(modelProfiles).where(eq(modelProfiles.providerId, row.id)).run();
    const models = isCustom
      ? await this.discoverCustomModels(baseUrl, key)
      : preset.models.map((m) => ({ id: m.id, name: m.name, contextLimit: m.contextLimit, outputLimit: m.outputLimit }));
    for (const m of models) {
      this.deps.db
        .insert(modelProfiles)
        .values({
          providerId: row.id,
          modelId: m.id,
          family: m.name,
          contextLimit: m.contextLimit,
          outputLimit: m.outputLimit,
          enabled: true,
        })
        .run();
    }
  }

  private async discoverCustomModels(baseUrl: string, key: string): Promise<{ id: string; name: string; contextLimit: number; outputLimit: number }[]> {
    const discover = this.deps.discoverModels ?? discoverModelsFromEndpoint;
    const ids = await discover(baseUrl, key);
    return ids.map((id) => ({ id, name: id, contextLimit: 128_000, outputLimit: 8_192 }));
  }
}
```

**The `custom` preset's base URL and models.** `discoverModelsFromEndpoint` reads the model list of an OpenAI-compatible endpoint:

```ts
/** Reads the model ids of an OpenAI-compatible endpoint. Returns [] when the route is absent. */
export async function discoverModelsFromEndpoint(baseUrl: string, key: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
  } catch {
    return [];
  }
}
```

Add it to the same file, above the class.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/provider-registry.test.ts`
Expected: PASS — 7 tests. If `connect` is async, add `await` to every call in the test.

- [ ] **Step 6: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/providers/service.ts apps/orchestrator/test/provider-registry.test.ts
git commit -m "feat(orchestrator): add the provider registry service"
```

---

### Task 5: Gateway upstream rewriting (pure functions)

**Files:**
- Create: `apps/orchestrator/src/gateway/upstream.ts`
- Create: `apps/orchestrator/test/gateway-upstream.test.ts`

**Interfaces:**
- Consumes: `AuthFlavour` (Task 2).
- Produces:
  ```ts
  export interface UpstreamTarget { baseUrl: string; auth: AuthFlavour; key: string | null; }
  export interface UpstreamCall { url: string; headers: Record<string, string>; }
  export function buildUpstreamUrl(baseUrl: string, path: string, query: string): string;
  export function stripAuthHeaders(headers: Record<string, string>): Record<string, string>;
  export function localToken(headers: Record<string, string>, query: string): string | null;
  export function buildUpstreamCall(target: UpstreamTarget, req: { path: string; query: string; headers: Record<string, string> }): UpstreamCall;
  ```

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/test/gateway-upstream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildUpstreamCall, buildUpstreamUrl, localToken, stripAuthHeaders } from '../src/gateway/upstream.ts';

describe('buildUpstreamUrl', () => {
  it('joins the base URL with the incoming path and query', () => {
    expect(buildUpstreamUrl('https://api.z.ai/api/paas/v4', '/chat/completions', '')).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(buildUpstreamUrl('https://api.anthropic.com/v1', '/messages', '')).toBe('https://api.anthropic.com/v1/messages');
    expect(buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', '/models/gemini-3-pro:streamGenerateContent', 'alt=sse')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse',
    );
  });

  it('does not double the version segment', () => {
    expect(buildUpstreamUrl('https://api.openai.com/v1', '/responses', '')).toBe('https://api.openai.com/v1/responses');
    expect(buildUpstreamUrl('http://127.0.0.1:11434/v1', '/chat/completions', '')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});

describe('stripAuthHeaders', () => {
  it('removes every credential header and keeps the rest', () => {
    const headers = {
      authorization: 'Bearer local-token',
      'x-api-key': 'local-token',
      'x-goog-api-key': 'local-token',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    expect(stripAuthHeaders(headers)).toEqual({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
  });
});

describe('localToken', () => {
  it('reads the token from any of the three header styles and the query', () => {
    expect(localToken({ authorization: 'Bearer abc' }, '')).toBe('abc');
    expect(localToken({ 'x-api-key': 'abc' }, '')).toBe('abc');
    expect(localToken({ 'x-goog-api-key': 'abc' }, '')).toBe('abc');
    expect(localToken({}, 'key=abc')).toBe('abc');
    expect(localToken({}, '')).toBeNull();
  });
});

describe('buildUpstreamCall', () => {
  const base = { path: '/chat/completions', query: '', headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' } };

  it('injects a bearer credential', () => {
    const call = buildUpstreamCall({ baseUrl: 'https://api.z.ai/api/paas/v4', auth: 'bearer', key: 'sk-real' }, base);
    expect(call.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-real');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('injects an x-api-key credential and keeps the anthropic version', () => {
    const call = buildUpstreamCall(
      { baseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key', key: 'sk-ant-real' },
      { path: '/messages', query: '', headers: { 'x-api-key': 'local-token', 'anthropic-version': '2023-06-01' } },
    );
    expect(call.headers['x-api-key']).toBe('sk-ant-real');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('injects a google credential', () => {
    const call = buildUpstreamCall(
      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'x-goog-api-key', key: 'AIza-real' },
      { path: '/models/m1:streamGenerateContent', query: 'alt=sse', headers: { 'x-goog-api-key': 'local-token' } },
    );
    expect(call.headers['x-goog-api-key']).toBe('AIza-real');
  });

  it('injects a placeholder when the provider needs no key', () => {
    const call = buildUpstreamCall({ baseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', key: null }, base);
    expect(call.headers.authorization).toBe('Bearer local');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/gateway-upstream.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/upstream.ts'`.

- [ ] **Step 3: Write the implementation**

`apps/orchestrator/src/gateway/upstream.ts`:

```ts
// apps/orchestrator/src/gateway/upstream.ts — pure URL and credential rewriting.
import type { AuthFlavour } from '@aik/providers';

export interface UpstreamTarget {
  baseUrl: string;
  auth: AuthFlavour;
  key: string | null;
}

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
}

const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key'];

/** The upstream URL is the provider's base URL plus the incoming path — the version prefix belongs to the base URL. */
export function buildUpstreamUrl(baseUrl: string, path: string, query: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const qs = query ? `?${query}` : '';
  return `${base}${suffix}${qs}`;
}

export function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (AUTH_HEADERS.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** The local gateway token, from whichever header the provider's AI SDK package uses. */
export function localToken(headers: Record<string, string>, query: string): string | null {
  const auth = headers.authorization;
  if (auth) return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
  if (headers['x-api-key']) return headers['x-api-key'];
  if (headers['x-goog-api-key']) return headers['x-goog-api-key'];
  if (headers['api-key']) return headers['api-key'];
  const fromQuery = new URLSearchParams(query).get('key');
  return fromQuery ?? null;
}

export function buildUpstreamCall(
  target: UpstreamTarget,
  req: { path: string; query: string; headers: Record<string, string> },
): UpstreamCall {
  const headers = stripAuthHeaders(req.headers);
  const key = target.key;
  switch (target.auth) {
    case 'x-api-key':
      headers['x-api-key'] = key ?? '';
      break;
    case 'x-goog-api-key':
      headers['x-goog-api-key'] = key ?? '';
      break;
    case 'api-key':
      headers['api-key'] = key ?? '';
      break;
    case 'none':
      headers.authorization = 'Bearer local';
      break;
    default:
      headers.authorization = `Bearer ${key ?? ''}`;
      break;
  }
  return { url: buildUpstreamUrl(target.baseUrl, req.path, req.query), headers };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/gateway-upstream.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/gateway/upstream.ts apps/orchestrator/test/gateway-upstream.test.ts
git commit -m "feat(orchestrator): add the gateway upstream rewriting rules"
```

---

### Task 6: The gateway server

**Files:**
- Create: `apps/orchestrator/src/gateway/failure.ts`
- Create: `apps/orchestrator/src/gateway/server.ts`
- Create: `apps/orchestrator/test/gateway-server.test.ts`

**Interfaces:**
- Consumes: `buildUpstreamCall`, `localToken` (Task 5), `ProviderVault` (Task 3), `ProviderService` (Task 4), the redactor.
- Produces:
  ```ts
  // apps/orchestrator/src/gateway/failure.ts
  export type ProviderFailureReason = 'auth' | 'quota' | 'provider_down' | 'model_limit';
  export function failureReasonForStatus(status: number): ProviderFailureReason;
  export function formatProviderFailure(f: { status: number; reason: ProviderFailureReason; provider: string; detail: string }): string;
  export function parseProviderFailure(message: string): { status: number; reason: ProviderFailureReason; provider: string; detail: string } | null;

  // apps/orchestrator/src/gateway/server.ts
  export interface GatewayProviderSource {
    findConnected(providerId: string): { baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
    findByModel(modelId: string): { id: string; baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
    markQuotaExhausted(providerId: string, status: number, until: number | null): void;
  }
  export interface GatewayDeps {
    token: string;
    providers: GatewayProviderSource;
    vault: ProviderVault;
    redact: (text: string) => string;
    logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
  }
  export interface RunningGateway { port: number; close(): Promise<void>; }
  export async function startGateway(deps: GatewayDeps): Promise<RunningGateway>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/test/gateway-server.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startGateway, type RunningGateway } from '../src/gateway/server.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createRedactor } from '../src/secrets/redactor.ts';

interface Upstream { url: string; calls: { path: string; query: string; headers: http.IncomingHttpHeaders; body: string }[]; close(): void; }

async function startUpstream(handler: (body: string) => { status: number; body: string; contentType?: string }): Promise<Upstream> {
  const calls: Upstream['calls'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', query: '', headers: req.headers, body: raw });
      const out = handler(raw);
      res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => server.close() };
}

const providers = (baseUrl: string, modelIds: string[]) => ({
  findConnected: (id: string) => (id === 'mock' ? { baseUrl, auth: 'bearer' as const, modelIds } : null),
  findByModel: (modelId: string) => (modelIds.includes(modelId) ? { id: 'mock', baseUrl, auth: 'bearer' as const, modelIds } : null),
  markQuotaExhausted: () => undefined,
});

let gateway: RunningGateway | null = null;
afterEach(async () => {
  await gateway?.close();
  gateway = null;
});

describe('the model gateway', () => {
  it('injects the provider key and strips the local token', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const vault = new MemoryProviderVault();
    await vault.saveKey('mock', 'sk-real-key');
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault,
      redact: createRedactor().redact,
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(upstream.calls[0].headers.authorization).toBe('Bearer sk-real-key');
    expect(upstream.calls[0].path).toBe('/v1/chat/completions');
    upstream.close();
  });

  it('rejects a request without the gateway token and never calls the upstream', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: '{}' }));
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    upstream.close();
  });

  it('rejects a provider that is not connected', async () => {
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers('http://127.0.0.1:1/v1', ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'not-connected' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a model that does not belong to the named provider', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: '{}' }));
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock' },
      body: JSON.stringify({ model: 'not-mine' }),
    });
    expect(res.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
    upstream.close();
  });

  it('passes an upstream error status through with a parseable marker', async () => {
    const upstream = await startUpstream(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }));
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock' },
      body: JSON.stringify({ model: 'm1' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('[aik-provider-error]');
    upstream.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/gateway-server.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/server.ts'`.

- [ ] **Step 3: Write the failure marker**

`apps/orchestrator/src/gateway/failure.ts`:

```ts
// apps/orchestrator/src/gateway/failure.ts — a machine-readable marker for upstream failures.
export type ProviderFailureReason = 'auth' | 'quota' | 'provider_down' | 'model_limit';

export const PROVIDER_FAILURE_MARKER = '[aik-provider-error]';

export function failureReasonForStatus(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'provider_down';
}

export function formatProviderFailure(f: { status: number; reason: ProviderFailureReason; provider: string; detail: string }): string {
  const detail = f.detail.replace(/\s+/g, ' ').slice(0, 300);
  return `${PROVIDER_FAILURE_MARKER} status=${f.status} reason=${f.reason} provider=${f.provider} detail=${detail}`;
}

export function parseProviderFailure(
  message: string,
): { status: number; reason: ProviderFailureReason; provider: string; detail: string } | null {
  const at = message.indexOf(PROVIDER_FAILURE_MARKER);
  if (at < 0) return null;
  const rest = message.slice(at + PROVIDER_FAILURE_MARKER.length);
  const status = /status=(\d+)/.exec(rest)?.[1];
  const reason = /reason=(auth|quota|provider_down|model_limit)/.exec(rest)?.[1];
  const provider = /provider=([^\s]+)/.exec(rest)?.[1];
  const detail = /detail=(.*)/.exec(rest)?.[1] ?? '';
  if (!status || !reason || !provider) return null;
  return { status: Number(status), reason: reason as ProviderFailureReason, provider, detail };
}
```

**Note:** the `status === 400 && false` line in `failureReasonForStatus` is dead code — delete it. A `400` from the upstream is a bad request, which maps to `provider_down` under the default branch. Keep the function as:

```ts
export function failureReasonForStatus(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'provider_down';
}
```

- [ ] **Step 4: Write the gateway server**

The gateway retries a **5xx or a transport failure** twice with backoff before giving up (spec PK-7); it never retries a 4xx, and it never retries against a different provider.

`apps/orchestrator/src/gateway/server.ts`:

```ts
// apps/orchestrator/src/gateway/server.ts — the loopback model proxy (spec PK-3).
// The provider key is read from the vault, injected into the upstream request and dropped.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthFlavour } from '@aik/providers';
import type { ProviderVault } from '../providers/vault.ts';
import { buildUpstreamCall, localToken } from './upstream.ts';
import { failureReasonForStatus, formatProviderFailure } from './failure.ts';

export interface GatewayProviderSource {
  findConnected(providerId: string): { baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
  findByModel(modelId: string): { id: string; baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
  markQuotaExhausted(providerId: string, status: number, until: number | null): void;
}

export interface GatewayDeps {
  token: string;
  providers: GatewayProviderSource;
  vault: ProviderVault;
  redact: (text: string) => string;
  logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

export interface RunningGateway {
  port: number;
  close(): Promise<void>;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function modelIdOf(path: string, body: Buffer): string | null {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.length > 0) return parsed.model;
    } catch {
      // Not JSON — fall through to the path.
    }
  }
  const fromPath = /\/models\/([^/:]+)/.exec(path)?.[1];
  return fromPath ?? null;
}

export async function startGateway(deps: GatewayDeps): Promise<RunningGateway> {
  const server = http.createServer((req, res) => {
    void handle(deps, req, res).catch((err) => {
      deps.logger?.warn({ err }, 'gateway request failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The gateway failed to handle the request' } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(deps: GatewayDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v) && v.length > 0) headers[k] = v.join(', ');
  }

  const presented = localToken(headers, url.search.slice(1));
  if (!presented || !safeEqual(presented, deps.token)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Missing or invalid gateway token' } }));
    return;
  }

  const body = await readBody(req);
  const providerId = headers['x-aik-provider'] ?? null;
  const modelId = modelIdOf(url.pathname, body);

  let target = providerId ? deps.providers.findConnected(providerId) : null;
  let resolvedId = providerId;
  if (!target && modelId) {
    const byModel = deps.providers.findByModel(modelId);
    if (byModel) {
      target = byModel;
      resolvedId = byModel.id;
    }
  }
  if (!target || !resolvedId) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PROVIDER_NOT_CONNECTED', message: 'That provider is not connected' } }));
    return;
  }
  if (modelId && !target.modelIds.includes(modelId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `The model ${modelId} does not belong to ${resolvedId}` } }));
    return;
  }

  const key = await deps.vault.loadKey(resolvedId);
  if (!key) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PROVIDER_NOT_CONNECTED', message: 'That provider is not connected' } }));
    return;
  }

  const call = buildUpstreamCall({ baseUrl: target.baseUrl, auth: target.auth, key }, { path: url.pathname, query: url.search.slice(1), headers });

  let upstream: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      upstream = await fetch(call.url, {
        method: req.method,
        headers: call.headers,
        body: body.length > 0 ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(600_000),
      });
    } catch (err) {
      lastError = err;
      upstream = null;
    }
    // Only a 5xx or a transport failure is retried; a 4xx is the caller's problem.
    if (upstream && upstream.status < 500) break;
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 1500));
    }
  }

  if (!upstream) {
    const message = formatProviderFailure({
      status: 0,
      reason: 'provider_down',
      provider: resolvedId,
      detail: deps.redact(lastError instanceof Error ? lastError.message : String(lastError)),
    });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const reason = failureReasonForStatus(upstream.status);
    if (reason === 'quota') deps.providers.markQuotaExhausted(resolvedId, upstream.status, null);
    const message = formatProviderFailure({
      status: upstream.status,
      reason,
      provider: resolvedId,
      detail: deps.redact(text).slice(0, 300),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
    return;
  }

  const outHeaders: Record<string, string> = {};
  const contentType = upstream.headers.get('content-type');
  if (contentType) outHeaders['content-type'] = contentType;
  res.writeHead(200, outHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/gateway-server.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/gateway apps/orchestrator/test/gateway-server.test.ts
git commit -m "feat(orchestrator): add the loopback model gateway"
```

---

### Task 7: Contracts and the orchestrator API

**Files:**
- Create: `packages/contracts/src/providers.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/orchestrator/src/api/routes/providers.ts`
- Create: `apps/orchestrator/test/provider-routes.test.ts`

**Interfaces:**
- Consumes: `ProviderService` (Task 4), `startGateway` (Task 6).
- Produces:
  ```ts
  // packages/contracts/src/providers.ts
  export type ProviderKindDTO = 'openai_compatible' | 'anthropic' | 'google' | 'ollama';
  export interface ProviderModelDTO { id: string; name: string; contextLimit: number; outputLimit: number; inputCost: number | null; outputCost: number | null; }
  export interface ProviderDTO {
    id: string; label: string; kind: ProviderKindDTO; npm: string; baseUrl: string;
    connected: boolean; connectedId: string | null; featured: boolean;
    costClass: CostClass; dataUse: DataUse; doc: string | null;
    env: string[]; unsupportedReason: string | null; models: ProviderModelDTO[];
  }
  export const ConnectProviderSchema: z.ZodType<{ providerId: string; apiKey?: string; baseUrl?: string }>;
  export const SetDefaultModelSchema: z.ZodType<{ providerId: string; modelId: string }>;
  ```

- [ ] **Step 1: Write the contracts file**

`packages/contracts/src/providers.ts`:

```ts
// packages/contracts/src/providers.ts — the provider DTOs the renderer sees. No key material.
import { z } from 'zod';

export type ProviderKindDTO = 'openai_compatible' | 'anthropic' | 'google' | 'ollama';
export type CostClassDTO = 'local' | 'free' | 'free_limited' | 'paid_flat' | 'paid_metered';
export type DataUseDTO = 'no_training' | 'may_train' | 'unknown';

export interface ProviderModelDTO {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  inputCost: number | null;
  outputCost: number | null;
}

export interface ProviderDTO {
  id: string;
  label: string;
  kind: ProviderKindDTO;
  /** The AI SDK package OpenCode must use for this provider's protocol. */
  npm: string;
  baseUrl: string;
  connected: boolean;
  /** The provider row's name — different from `id` for a custom endpoint (`custom-<slug>`). */
  connectedId: string | null;
  /** True when the provider is shown first in the picker. */
  featured: boolean;
  costClass: CostClassDTO;
  dataUse: DataUseDTO;
  doc: string | null;
  /** The upstream environment variable names, shown as a hint. */
  env: string[];
  /** Set when the provider cannot be connected with a key alone. */
  unsupportedReason: string | null;
  models: ProviderModelDTO[];
}

export const ConnectProviderSchema = z.object({
  providerId: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(500).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
});

export const SetDefaultModelSchema = z.object({
  providerId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
});
```

Add the export to `packages/contracts/src/index.ts` (alphabetical, after `./opencode.ts`):

```ts
export * from './providers.ts';
```

- [ ] **Step 2: Write the failing route test**

`apps/orchestrator/test/provider-routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.ts';
import { registerProviderRoutes } from '../src/api/routes/providers.ts';
import { ProviderService } from '../src/providers/service.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createTestDb } from './helpers/db.ts';
import { createRedactor } from '../src/secrets/redactor.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41237;

async function build() {
  const t = createTestDb();
  const vault = new MemoryProviderVault();
  const providers = new ProviderService({ db: t.db, vault, now: () => 1_700_000_000_000 });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProviderRoutes(app, { providers, now: () => 1_700_000_000_000 });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) },
    });
  return { t, vault, providers, call };
}

describe('the provider routes', () => {
  it('lists the catalog with no key material', async () => {
    const { call } = await build();
    const res = await call('GET', '/providers');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: { id: string }[] };
    expect(body.providers.length).toBeGreaterThan(100);
    expect(res.body).not.toMatch(/sk-/);
  });

  it('connects a provider and never returns the key', async () => {
    const { call, vault } = await build();
    const res = await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy-secret' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-dummy-secret');
    expect(await vault.loadKey('openai')).toBe('sk-dummy-secret');
  });

  it('rejects an unknown provider with 400', async () => {
    const { call } = await build();
    const res = await call('POST', '/providers', { providerId: 'nope', apiKey: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('removes a provider', async () => {
    const { call, vault } = await build();
    await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy' });
    const res = await call('DELETE', '/providers/openai');
    expect(res.statusCode).toBe(200);
    expect(await vault.loadKey('openai')).toBeNull();
  });

  it('stores and reads the default model', async () => {
    const { call } = await build();
    await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy' });
    const put = await call('PUT', '/settings/default-model', { providerId: 'openai', modelId: 'gpt-4o' });
    expect(put.statusCode).toBe(200);
    const get = await call('GET', '/settings/default-model');
    expect(get.json()).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/provider-routes.test.ts`
Expected: FAIL — `Cannot find module '../src/api/routes/providers.ts'`.

- [ ] **Step 4: Write the routes**

`apps/orchestrator/src/api/routes/providers.ts`:

```ts
// apps/orchestrator/src/api/routes/providers.ts
import { ConnectProviderSchema, SetDefaultModelSchema } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProviderService } from '../../providers/service.ts';
import type { Clock } from '../../time.ts';
import { ApiHttpError } from '../errors.ts';
import { mutation, parse } from '../idempotency.ts';

const IdParam = z.object({ id: z.string().min(1).max(120) });

export function registerProviderRoutes(
  app: FastifyInstance,
  deps: { db: AikDb; now: Clock; providers: ProviderService },
): void {
  app.get('/providers', async () => ({ providers: deps.providers.list() }));

  mutation(app, deps, 'POST', '/providers', async (req) => {
    const body = parse(ConnectProviderSchema, req.body);
    try {
      const provider = await deps.providers.connect(body);
      return { status: 200, body: { ok: true, provider } };
    } catch (err) {
      throw new ApiHttpError(400, 'PROVIDER_REJECTED', err instanceof Error ? err.message : String(err));
    }
  });

  mutation(app, deps, 'DELETE', '/providers/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    deps.providers.remove(id);
    return { status: 200, body: { ok: true } };
  });

  app.get('/settings/default-model', async () => deps.providers.getDefaultModel() ?? { providerId: null, modelId: null });

  mutation(app, deps, 'PUT', '/settings/default-model', async (req) => {
    const body = parse(SetDefaultModelSchema, req.body);
    try {
      deps.providers.setDefaultModel(body);
    } catch (err) {
      throw new ApiHttpError(400, 'PROVIDER_REJECTED', err instanceof Error ? err.message : String(err));
    }
    return { status: 200, body: { ok: true } };
  });
}
```

**There is deliberately no "test" route.** The connection test runs through **OpenCode**
in the desktop (`opencodeChat`), because only OpenCode speaks each provider's native
protocol — the gateway forwards a body verbatim and cannot produce an Anthropic- or
Google-shaped request itself. The card's Test button reuses the desktop helper
(Task 11).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/provider-routes.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/providers.ts packages/contracts/src/index.ts apps/orchestrator/src/api/routes/providers.ts apps/orchestrator/test/provider-routes.test.ts
git commit -m "feat(orchestrator,contracts): add the provider API routes and DTOs"
```

---

### Task 8: The default model drives the agent runtime

**Files:**
- Modify: `apps/orchestrator/src/agents/runtime.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Create: `apps/orchestrator/test/default-model.test.ts`

**Interfaces:**
- Consumes: `ProviderService.getDefaultModel()` (Task 4).
- Produces: `OpenCodeRuntime` accepts `defaultModel`; the orchestrator passes the stored default.

- [ ] **Step 1: Write the failing test**

`apps/orchestrator/test/default-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OpenCodeRuntime } from '../src/agents/runtime.ts';

describe('OpenCodeRuntime.resolveModel', () => {
  it('prefers the configured default model', async () => {
    const runtime = new OpenCodeRuntime({ defaultModel: { providerID: 'zai', id: 'glm-4.6' } });
    expect(await runtime.resolveModel()).toEqual({ providerID: 'zai', id: 'glm-4.6' });
  });

  it('prefers an explicit model over the default', async () => {
    const runtime = new OpenCodeRuntime({ defaultModel: { providerID: 'zai', id: 'glm-4.6' } });
    expect(await runtime.resolveModel({ providerID: 'openai', id: 'gpt-4o' })).toEqual({ providerID: 'openai', id: 'gpt-4o' });
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (it should already)**

Run: `npx vitest run apps/orchestrator/test/default-model.test.ts`
Expected: PASS — the runtime already honours `defaultModel`. This task wires the *stored* default into the runtime; the unit test above locks the precedence.

- [ ] **Step 3: Wire the stored default into the orchestrator**

In `apps/orchestrator/src/app.ts`, after the `ProviderService` is created, pass the stored default to the runtime. The runtime is created on line ~97 (`const runtime = new OpenCodeRuntime();`), **before** the provider service exists — move the runtime creation below the provider service and change it to:

```ts
  const providerVault = createProviderVault();
  const providerService = new ProviderService({ db, vault: providerVault, now: systemClock });
  const storedDefault = providerService.getDefaultModel();
  const runtime = new OpenCodeRuntime(
    storedDefault ? { defaultModel: { providerID: storedDefault.providerId, id: storedDefault.modelId } } : {},
  );
```

and add the imports:

```ts
import { createProviderVault } from './providers/vault.ts';
import { ProviderService } from './providers/service.ts';
```

- [ ] **Step 4: Register the provider routes**

In `apps/orchestrator/src/app.ts`, next to the other `register…Routes` calls:

```ts
  registerProviderRoutes(app, { db, now: systemClock, providers: providerService });
```

and add the import:

```ts
import { registerProviderRoutes } from './api/routes/providers.ts';
```

- [ ] **Step 5: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/app.ts apps/orchestrator/src/agents/runtime.ts apps/orchestrator/test/default-model.test.ts
git commit -m "feat(orchestrator): drive the agent model from the stored default"
```

---

### Task 9: The desktop's OpenCode configuration and the process plumbing

**Files:**
- Create: `apps/desktop/src/main/opencode-config.ts`
- Create: `apps/desktop/src/main/gateway-context.ts`
- Modify: `apps/desktop/src/main/opencode-server.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/orchestrator/src/app.ts`
- Modify: `apps/orchestrator/src/main.ts`
- Create: `apps/desktop/test/opencode-config.test.ts`

**Interfaces:**
- Consumes: `ProviderDTO` (Task 7), the orchestrator's `ready` message.
- Produces:
  ```ts
  // apps/desktop/src/main/opencode-config.ts
  export interface OpenCodeModelSpec { id: string; name: string; contextLimit: number; outputLimit: number; }
  export interface OpenCodeProviderSpec { id: string; npm: string; models: OpenCodeModelSpec[]; }
  export interface OpenCodeProviderConfig {
    npm: string;
    options: { baseURL: string; apiKey: string; headers: Record<string, string> };
    models: Record<string, { name: string; limit: { context: number; output: number } }>;
  }
  export function buildProviderConfig(input: {
    providers: OpenCodeProviderSpec[];
    gatewayBaseUrl: string;
    gatewayToken: string;
  }): Record<string, OpenCodeProviderConfig>;

  // apps/desktop/src/main/gateway-context.ts
  export interface GatewayContext { baseUrl: string | null; token: string; providers: OpenCodeProviderSpec[]; }
  export function setGatewayContext(ctx: Partial<GatewayContext>): void;
  export function getGatewayContext(): GatewayContext;
  ```

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/opencode-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildProviderConfig } from '../src/main/opencode-config.ts';

describe('buildProviderConfig', () => {
  it('builds one virtual provider per connected upstream provider', () => {
    const config = buildProviderConfig({
      providers: [
        { id: 'zai', npm: '@ai-sdk/openai-compatible', models: [{ id: 'glm-4.6', name: 'GLM 4.6', contextLimit: 200000, outputLimit: 32768 }] },
        { id: 'anthropic', npm: '@ai-sdk/anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextLimit: 200000, outputLimit: 64000 }] },
      ],
      gatewayBaseUrl: 'http://127.0.0.1:53123',
      gatewayToken: 'local-gateway-token',
    });

    expect(Object.keys(config)).toEqual(['anthropic', 'zai']);
    expect(config.zai.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.zai.options.baseURL).toBe('http://127.0.0.1:53123');
    expect(config.zai.options.apiKey).toBe('local-gateway-token');
    expect(config.zai.options.headers).toEqual({ 'x-aik-provider': 'zai' });
    expect(config.zai.models['glm-4.6'].limit).toEqual({ context: 200000, output: 32768 });
    expect(config.anthropic.npm).toBe('@ai-sdk/anthropic');
  });

  it('never contains a provider key — only the gateway token', () => {
    const config = buildProviderConfig({
      providers: [{ id: 'zai', npm: '@ai-sdk/openai-compatible', models: [{ id: 'glm-4.6', name: 'GLM 4.6', contextLimit: 1, outputLimit: 1 }] }],
      gatewayBaseUrl: 'http://127.0.0.1:1',
      gatewayToken: 'local-gateway-token',
    });
    expect(JSON.stringify(config)).not.toMatch(/sk-/);
  });

  it('returns an empty map when nothing is connected', () => {
    expect(buildProviderConfig({ providers: [], gatewayBaseUrl: 'http://127.0.0.1:1', gatewayToken: 't' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/desktop/test/opencode-config.test.ts`
Expected: FAIL — `Cannot find module '../src/main/opencode-config.ts'`.

- [ ] **Step 3: Write the config builder**

`apps/desktop/src/main/opencode-config.ts`:

```ts
// apps/desktop/src/main/opencode-config.ts — the virtual providers the isolated OpenCode server sees.
export interface OpenCodeModelSpec {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
}

export interface OpenCodeProviderSpec {
  id: string;
  npm: string;
  models: OpenCodeModelSpec[];
}

export interface OpenCodeProviderConfig {
  npm: string;
  options: { baseURL: string; apiKey: string; headers: Record<string, string> };
  models: Record<string, { name: string; limit: { context: number; output: number } }>;
}

/**
 * One virtual provider per connected upstream provider. Each keeps its own AI SDK package,
 * so OpenCode speaks that provider's native protocol, and points at the loopback gateway
 * with the gateway token — never the provider key.
 */
export function buildProviderConfig(input: {
  providers: OpenCodeProviderSpec[];
  gatewayBaseUrl: string;
  gatewayToken: string;
}): Record<string, OpenCodeProviderConfig> {
  const out: Record<string, OpenCodeProviderConfig> = {};
  for (const provider of input.providers) {
    const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
    for (const model of provider.models) {
      models[model.id] = { name: model.name, limit: { context: model.contextLimit, output: model.outputLimit } };
    }
    out[provider.id] = {
      npm: provider.npm,
      options: {
        baseURL: input.gatewayBaseUrl,
        apiKey: input.gatewayToken,
        headers: { 'x-aik-provider': provider.id },
      },
      models,
    };
  }
  return out;
}
```

- [ ] **Step 4: Write the gateway context**

`apps/desktop/src/main/gateway-context.ts`:

```ts
// apps/desktop/src/main/gateway-context.ts — what the main process knows about the gateway.
import type { OpenCodeProviderSpec } from './opencode-config.ts';

export interface GatewayContext {
  baseUrl: string | null;
  token: string;
  providers: OpenCodeProviderSpec[];
}

let context: GatewayContext = { baseUrl: null, token: '', providers: [] };

export function setGatewayContext(next: Partial<GatewayContext>): void {
  context = { ...context, ...next };
}

export function getGatewayContext(): GatewayContext {
  return context;
}
```

- [ ] **Step 5: Use the config in the OpenCode server**

In `apps/desktop/src/main/opencode-server.ts`, replace `configContent()` with:

```ts
/** The generated configuration: the virtual providers plus the existing isolation settings. */
function configContent(): Record<string, unknown> {
  const config: Record<string, unknown> = { snapshots: false };
  const ctx = getGatewayContext();
  if (ctx.baseUrl && ctx.providers.length > 0) {
    config.provider = buildProviderConfig({ providers: ctx.providers, gatewayBaseUrl: ctx.baseUrl, gatewayToken: ctx.token });
  }
  const mockUrl = process.env.AIK_OPENCODE_BASE_URL;
  if (mockUrl) {
    config.provider = {
      mock: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: mockUrl, apiKey: 'spike-not-a-secret' },
        models: { 'mock-model': { capabilities: { tools: true }, limit: { context: 131072, output: 8192 } } },
      },
    };
  }
  return config;
}
```

and add the imports:

```ts
import { getGatewayContext } from './gateway-context.ts';
import { buildProviderConfig } from './opencode-config.ts';
```

**Note:** the mock entry moved from the `providers`/`package`/`settings` shape to the `provider`/`npm`/`options` shape (spec PK-4.5). Both work in 2.0.32; the new shape matches the catalog.

- [ ] **Step 6: Generate the gateway token and publish the context**

In `apps/desktop/src/main/index.ts`, next to the existing `const token = crypto.randomBytes(32).toString('base64url');`:

```ts
  const gatewayToken = crypto.randomBytes(32).toString('base64url');
  setGatewayContext({ token: gatewayToken });
```

and pass it in the init message:

```ts
    initMessage: () => ({
      type: 'init',
      token,
      gatewayToken,
      dataDir: paths.dataDir,
      ...
    }),
```

and add the import:

```ts
import { setGatewayContext } from './gateway-context.ts';
```

- [ ] **Step 7: Start the gateway in the orchestrator and report its port**

In `apps/orchestrator/src/app.ts`, add `gatewayToken: string` to `OrchestratorOptions`, and after the provider service is created:

```ts
  const gateway = await startGateway({
    token: opts.gatewayToken,
    providers: providerService,
    vault: providerVault,
    redact: redactor.redact,
    logger: { info: (obj, msg) => logger.info(obj, msg), warn: (obj, msg) => logger.warn(obj, msg) },
  });
```

and add `gatewayPort: gateway.port` to the returned object:

```ts
  return {
    port,
    gatewayPort: gateway.port,
    close: async () => {
      clearInterval(pollTimer);
      await gateway.close();
      runner.stop();
      ...
```

**`ProviderService` must satisfy `GatewayProviderSource`.** Add these three methods to `ProviderService`:

```ts
  findConnected(providerId: string): { baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null {
    const found = this.getConnected().find((p) => p.id === providerId);
    return found ? { baseUrl: found.baseUrl, auth: found.auth, modelIds: found.modelIds } : null;
  }

  findByModel(modelId: string): { id: string; baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null {
    for (const p of this.getConnected()) {
      if (p.modelIds.includes(modelId)) return { id: p.id, baseUrl: p.baseUrl, auth: p.auth, modelIds: p.modelIds };
    }
    return null;
  }
```

`markQuotaExhausted` already exists on `ProviderService` with the matching signature.

- [ ] **Step 8: Report the gateway port to the desktop**

In `apps/orchestrator/src/main.ts`, change the ready message:

```ts
        parentPort.postMessage({ type: 'ready', port: r.port, gatewayPort: r.gatewayPort });
```

- [ ] **Step 9: Publish the provider list when the orchestrator is ready**

In `apps/desktop/src/main/supervisor.ts`, carry the gateway port on the `ready` event. Extend the class field:

```ts
  gatewayPort: number | null = null;
```

and in `onMessage`:

```ts
    if (m.type === 'ready' && typeof m.port === 'number') {
      this.port = m.port;
      if (typeof m.gatewayPort === 'number') this.gatewayPort = m.gatewayPort;
      this.consecutive = 0;
      this.setState('ready');
      this.emit('ready', m.port, this.gatewayPort);
    }
```

In `apps/desktop/src/main/index.ts`, add the helper and the listener:

```ts
/** Reads the connected providers from the orchestrator and publishes them for the config generator. */
async function refreshGatewayContext(port: number, gatewayPort: number | null): Promise<void> {
  if (gatewayPort === null) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/providers`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const body = (await res.json()) as {
      providers: { id: string; connectedId: string | null; npm: string; connected: boolean; models: { id: string; name: string; contextLimit: number; outputLimit: number }[] }[];
    };
    const connected = body.providers.filter((p) => p.connected && p.connectedId);
    setGatewayContext({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      // The virtual provider id is the *connected* id (`custom-<slug>` for a custom endpoint).
      providers: connected.map((p) => ({ id: p.connectedId as string, npm: p.npm, models: p.models })),
    });
  } catch {
    // The orchestrator is not reachable — the model list reports the error.
  }
}
```

and the listener, next to the other `supervisor.on(...)` calls in `main()`:

```ts
  supervisor.on('ready', (port: number, gatewayPort: number | null) => {
    void refreshGatewayContext(port, gatewayPort);
  });
```

`token` and `gatewayToken` are both in scope inside `main()`.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run apps/desktop/test/opencode-config.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 11: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/main apps/desktop/test/opencode-config.test.ts apps/orchestrator/src/app.ts apps/orchestrator/src/main.ts apps/orchestrator/src/providers/service.ts
git commit -m "feat(desktop,orchestrator): point the isolated OpenCode server at the model gateway"
```

---

### Task 10: Classifying provider failures

**Files:**
- Modify: `packages/contracts/src/providers.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/orchestrator/src/agents/implementer.ts`
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/agents/planner.ts`
- Create: `apps/orchestrator/test/provider-failure.test.ts`

**Interfaces:**
- Consumes: `parseProviderFailure` (Task 6, moved to contracts so the agents can import it).
- Produces: `packages/contracts/src/providers.ts` gains `ProviderFailureReason`, `parseProviderFailure`, `formatProviderFailure`, `PROVIDER_FAILURE_MARKER`.

- [ ] **Step 1: Move the failure helpers into contracts**

Delete `apps/orchestrator/src/gateway/failure.ts` and add its contents to `packages/contracts/src/providers.ts`:

```ts
export type ProviderFailureReason = 'auth' | 'quota' | 'provider_down' | 'model_limit';

export const PROVIDER_FAILURE_MARKER = '[aik-provider-error]';

export function failureReasonForStatus(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'provider_down';
}

export function formatProviderFailure(f: { status: number; reason: ProviderFailureReason; provider: string; detail: string }): string {
  const detail = f.detail.replace(/\s+/g, ' ').slice(0, 300);
  return `${PROVIDER_FAILURE_MARKER} status=${f.status} reason=${f.reason} provider=${f.provider} detail=${detail}`;
}

export function parseProviderFailure(
  message: string,
): { status: number; reason: ProviderFailureReason; provider: string; detail: string } | null {
  const at = message.indexOf(PROVIDER_FAILURE_MARKER);
  if (at < 0) return null;
  const rest = message.slice(at + PROVIDER_FAILURE_MARKER.length);
  const status = /status=(\d+)/.exec(rest)?.[1];
  const reason = /reason=(auth|quota|provider_down|model_limit)/.exec(rest)?.[1];
  const provider = /provider=([^\s]+)/.exec(rest)?.[1];
  const detail = /detail=(.*)/.exec(rest)?.[1] ?? '';
  if (!status || !reason || !provider) return null;
  return { status: Number(status), reason: reason as ProviderFailureReason, provider, detail };
}
```

and update the gateway's imports to `@aik/contracts`.

- [ ] **Step 2: Write the failing test**

`apps/orchestrator/test/provider-failure.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatProviderFailure, parseProviderFailure } from '@aik/contracts';

describe('the provider failure marker', () => {
  it('round-trips a failure', () => {
    const text = formatProviderFailure({ status: 401, reason: 'auth', provider: 'zai', detail: 'invalid api key' });
    expect(parseProviderFailure(`Some noise before it. ${text}`)).toEqual({
      status: 401,
      reason: 'auth',
      provider: 'zai',
      detail: 'invalid api key',
    });
  });

  it('returns null for an ordinary error', () => {
    expect(parseProviderFailure('the model timed out')).toBeNull();
  });

  it('maps the statuses to the blocked reasons', () => {
    expect(formatProviderFailure({ status: 429, reason: 'quota', provider: 'x', detail: '' })).toContain('reason=quota');
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/provider-failure.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4: Block with the provider's reason**

In `apps/orchestrator/src/agents/implementer.ts`, in the failure branch (around line 360, where `blockStory` is called with `'environment'` / `'invalid_agent_output'`), classify the error first:

```ts
import { parseProviderFailure } from '@aik/contracts';
...
    const providerFailure = parseProviderFailure(error);
    if (providerFailure) {
      this.blockStory(story.id, providerFailure.reason, `The ${providerFailure.provider} provider failed: ${providerFailure.detail}`);
      return { ok: false, error };
    }
```

Add the same check to `apps/orchestrator/src/agents/reviewer.ts` (before it blocks with its own reason) and to `apps/orchestrator/src/agents/planner.ts`.

- [ ] **Step 5: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/providers.ts apps/orchestrator/src/gateway apps/orchestrator/src/agents apps/orchestrator/test/provider-failure.test.ts
git commit -m "feat(orchestrator): block stories with the provider's own failure reason"
```

---

### Task 11: The Settings UI

**Files:**
- Modify: `apps/ui/src/lib/api.ts`
- Create: `apps/ui/src/components/settings/providers-card.tsx`
- Modify: `apps/ui/src/routes/settings.tsx`
- Modify: `apps/desktop/src/main/bridge.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `packages/contracts/src/bridge.ts`
- Create: `apps/ui/test/providers-card.test.ts` — **or** a Playwright E2E (Task 12). The repo has no React test runner, so the card is covered by the E2E test in Task 12.

**Interfaces:**
- Consumes: `ProviderDTO` (Task 7), `api` (Task 11 Step 1).
- Produces: `window.api.restartOpencode(): Promise<void>`.

- [ ] **Step 1: Add `put` and `del` to the renderer's API helper**

In `apps/ui/src/lib/api.ts`, extend the exported helper:

```ts
export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};
```

- [ ] **Step 2: Add the IPC that restarts the isolated OpenCode server**

In `packages/contracts/src/bridge.ts`, add to `AikWindowApi`:

```ts
  /** Restarts the isolated OpenCode server so a newly connected provider appears in the model list. */
  restartOpencode(): Promise<void>;
```

In `apps/desktop/src/preload/index.ts`, add:

```ts
  restartOpencode: () => ipcRenderer.invoke('aik:opencode-restart'),
```

In `apps/desktop/src/main/bridge.ts`, add the handler:

```ts
  ipcMain.handle('aik:opencode-restart', (event) => {
    assertTrusted(event, deps);
    stopOpencodeServer();
  });
```

- [ ] **Step 3: Write the Providers card**

`apps/ui/src/components/settings/providers-card.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProviderDTO } from '@aik/contracts';
import { Button } from '../ui/button.tsx';
import { api, ApiRequestError } from '../../lib/api.ts';

interface Props {
  /** Personal mode uses the user's own OpenCode credentials; the card is not shown there. */
  managed: boolean;
}

function costLabel(p: ProviderDTO): string {
  if (p.costClass === 'free') return 'free';
  if (p.costClass === 'free_limited') return 'free tier';
  if (p.costClass === 'local') return 'local';
  if (p.costClass === 'paid_flat') return 'paid';
  return 'paid per token';
}

export function ProvidersCard({ managed }: Props) {
  const [providers, setProviders] = useState<ProviderDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const body = await api.get<{ providers: ProviderDTO[] }>('/providers');
      setProviders(body.providers);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    if (!providers) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? providers.filter((p) => p.id.includes(q) || p.label.toLowerCase().includes(q))
      : providers;
    const featured = filtered.filter((p) => p.featured);
    const rest = filtered.filter((p) => !p.featured);
    return [...featured, ...rest];
  }, [providers, query]);

  if (!managed) {
    return (
      <section className="mt-6" aria-label="Providers">
        <h2 className="font-semibold">Providers</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Personal mode uses your own OpenCode CLI and its credentials.
        </p>
      </section>
    );
  }

  const connect = async (p: ProviderDTO) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/providers', {
        providerId: p.id,
        ...(apiKey ? { apiKey } : {}),
        ...(p.id === 'custom' && baseUrl ? { baseUrl } : {}),
      });
      setApiKey('');
      setBaseUrl('');
      setExpanded(null);
      await window.api.restartOpencode();
      await refresh();
      setNotice(`${p.label} is connected.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: ProviderDTO) => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/providers/${encodeURIComponent(p.connectedId ?? p.id)}`);
      await window.api.restartOpencode();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The test runs through OpenCode, because only OpenCode speaks the provider's own
  // protocol. The virtual provider id is the connected id (`custom-<slug>` for a custom
  // endpoint, the catalog id otherwise).
  const test = async (p: ProviderDTO) => {
    const model = p.models[0];
    if (!model) {
      setError(`${p.label} exposes no model to test.`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await window.api.opencodeChat({ providerID: p.connectedId ?? p.id, id: model.id }, 'Reply with OK.');
    if (result.ok) setNotice(`${p.label} answered: ${result.text.slice(0, 80)}`);
    else {
      setError(`${p.label}: ${result.error}`);
      if (/401|403|unauthor|invalid.*key/i.test(result.error)) setRejected(p.id);
    }
    setBusy(false);
  };

  return (
    <section className="mt-6" aria-label="Providers">
      <h2 className="font-semibold">Providers</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Pick a provider and paste your API key. The key is kept in Windows Credential Manager and is
        never written to the database, the logs or OpenCode.
      </p>
      <input
        type="search"
        aria-label="Search providers"
        placeholder="Search providers"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mt-2 max-w-md rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
      <ul className="mt-2 flex max-w-2xl flex-col gap-1">
        {visible.map((p) => (
          <li key={p.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={expanded === p.id}
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
                disabled={Boolean(p.unsupportedReason) || busy}
                className="flex-1 text-left text-sm font-medium disabled:opacity-50"
              >
                {p.label}
                <span className="ml-2 text-xs font-normal text-zinc-500">{costLabel(p)}</span>
                {p.connected && <span className="ml-2 text-xs font-normal text-emerald-700">Connected</span>}
                {rejected.includes(p.id) && <span className="ml-2 text-xs font-normal text-red-600">Key rejected</span>}
                {p.unsupportedReason && <span className="ml-2 text-xs font-normal text-zinc-500">{p.unsupportedReason}</span>}
              </button>
              {p.connected && (
                <>
                  <Button disabled={busy || p.models.length === 0} onClick={() => void test(p)}>Test</Button>
                  <Button disabled={busy} onClick={() => void remove(p)}>Remove</Button>
                </>
              )}
            </div>
            {expanded === p.id && (
              <div className="mt-2 flex flex-col gap-2">
                {p.id === 'custom' && (
                  <label className="flex flex-col gap-1 text-sm">
                    Base URL
                    <input
                      type="url"
                      aria-label="Base URL"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="http://127.0.0.1:1234/v1"
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                  </label>
                )}
                {p.auth !== 'none' && (
                  <label className="flex flex-col gap-1 text-sm">
                    API key
                    <input
                      type="password"
                      aria-label={`API key for ${p.label}`}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                  </label>
                )}
                <div>
                  <Button variant="primary" disabled={busy} onClick={() => void connect(p)}>
                    {busy ? 'Connecting…' : 'Connect'}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

**Note:** the card's Test button needs the `opencodeChat` bridge method, which already
exists in `AikWindowApi` (`packages/contracts/src/bridge.ts`) — no new IPC is required
for it. The `restartOpencode` IPC added in Step 2 is the only new one.

- [ ] **Step 4: Mount the card**

In `apps/ui/src/routes/settings.tsx`, import the card and render it next to the model picker:

```tsx
import { ProvidersCard } from '../components/settings/providers-card.tsx';
...
      <ModelPicker status={opencode} />
      <ProvidersCard managed={mode === 'managed'} />
      <GitHubSettingsCard />
```

`mode` currently lives inside `ModelPicker`. Lift it: move the `mode` state and the `getAppSettings` effect into `SettingsPage`, pass `mode` into `ModelPicker` as a prop, and render `<ProvidersCard managed={mode === 'managed'} />` from `SettingsPage`.

- [ ] **Step 5: Make the default-model picker use the connected providers**

In `apps/ui/src/routes/settings.tsx`, the `ModelPicker` currently lists the models OpenCode reports. Extend it to also list the connected providers' models and persist the choice through `PUT /settings/default-model`:

```tsx
  const saveModel = async (providerID: string, id: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID, id }));
    try {
      await api.put('/settings/default-model', { providerId: providerID, modelId: id });
    } catch {
      // The local choice still applies to this session.
    }
  };
```

and call it from the select's `onChange`.

- [ ] **Step 6: Verify the repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/ui apps/desktop/src/main/bridge.ts apps/desktop/src/preload/index.ts packages/contracts/src/bridge.ts packages/contracts/src/providers.ts
git commit -m "feat(ui): add the Settings Providers card"
```

---

### Task 12: End-to-end verification

**Files:**
- Create: `e2e/tests/providers.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-22-provider-api-keys-design.md` — record the verification result.

**Interfaces:**
- Consumes: everything above.
- Produces: an E2E test that connects a provider and runs a story through the real gateway.

- [ ] **Step 1: Write the E2E test**

`e2e/tests/providers.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { apiCall, launchApp, makeTempDir, startMockLlm, waitReady } from '../fixtures.ts';

const KEY = 'sk-dummy-e2e-key';

test('connects a provider and keeps the key off disk and out of the model list', async () => {
  const dataDir = makeTempDir();
  const mock = await startMockLlm([{ content: 'OK.' }]);
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);

  // The catalog is listed.
  const list = await apiCall<{ providers: { id: string; connected: boolean }[] }>(page, 'GET', '/providers');
  expect(list.status).toBe(200);
  expect(list.body.providers.length).toBeGreaterThan(100);

  // Connect the mock provider as a custom endpoint.
  const connect = await apiCall(page, 'POST', '/providers', {
    providerId: 'custom',
    apiKey: KEY,
    baseUrl: mock.url,
  });
  expect(connect.status).toBe(200);
  expect(JSON.stringify(connect.body)).not.toContain(KEY);

  // It is listed as connected, with the model the endpoint advertises.
  const after = await apiCall<{ providers: { id: string; connected: boolean; models: { id: string }[] }[] }>(page, 'GET', '/providers');
  const custom = after.body.providers.find((p) => p.id === 'custom');
  expect(custom?.connected).toBe(true);
  expect(custom?.models.map((m) => m.id)).toContain('mock-model');

  // OpenCode now offers the connected provider's model.
  const models = await page.evaluate(async () => {
    const api = (window as unknown as { api: { opencodeModels: () => Promise<{ ok: boolean; models?: { providerID: string; id: string }[] }> } }).api;
    return api.opencodeModels();
  });
  expect(models.ok).toBe(true);
  expect(models.models?.some((m) => m.id === 'mock-model')).toBe(true);

  // The key is in neither the database nor the log.
  const db = fs.readFileSync(path.join(dataDir, 'app.db')).toString('latin1');
  expect(db).not.toContain(KEY);
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'orchestrator.log'), 'utf8');
  expect(log).not.toContain(KEY);

  mock.stop();
  await app.close();
});
```

- [ ] **Step 2: Run the E2E test**

Run: `npm run build && npx playwright test -c e2e/playwright.config.ts e2e/tests/providers.spec.ts`
Expected: PASS.

- [ ] **Step 3: Verify the whole repo still passes**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 4: Record the verification in the spec**

In `docs/superpowers/specs/2026-10-22-provider-api-keys-design.md`, append to §2 a row:

```
| 11 | Does the key appear in the database, the logs or an IPC payload? | **No.** The E2E test connects a provider with a dummy key and asserts the key is absent from the orchestrator's database file and its log file. | [V] |
```

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/providers.spec.ts docs/superpowers/specs/2026-10-22-provider-api-keys-design.md
git commit -m "test(e2e): connect a provider and verify the key never lands on disk"
```

---

## Completion Checklist

- [ ] `npm run check:pins && npm run lint && npm run typecheck && npm test` all pass.
- [ ] The provider key appears in no config file, database row, log line, file in the data directory, IPC payload or renderer message.
- [ ] The gateway token is rejected by every orchestrator API route, and the orchestrator API token is rejected by the gateway.
- [ ] The gateway never falls back to another provider.
- [ ] SPK-5 records a **[V]** verdict for P-1 and P-2, and the implementation matches them.
