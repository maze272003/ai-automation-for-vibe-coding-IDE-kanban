# Phase 1: Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows desktop app that launches safely, persists stories across restarts, and enforces the story state machine through a single authority. It provides a live Kanban board with drag and keyboard moves. No AI execution yet.

**Architecture:**
- An Electron 44 main process supervises a Node orchestrator running in a `utilityProcess`.
- The orchestrator serves a Fastify API on `127.0.0.1`, protected by a token generated per launch. It persists everything to SQLite through Drizzle and streams events over SSE.
- The renderer (Vite + React) never sees the token. It talks only to a narrow preload API, and **the Electron main process proxies API calls and the SSE stream**.
- Story state changes only through `WorkflowService`, which wraps a pure state machine in `packages/workflow`.

**Tech Stack (exact pins):**
- Runtime and language: Electron 44.9.0, Node ≥ 24.17.0, TypeScript 6.0.3.
- Frontend: Vite 8.3.4, React 19.3.1, @tanstack/react-router 1.170.45, Tailwind 4.3.3, @atlaskit/pragmatic-drag-and-drop 4.0.0.
- Backend and data: Fastify 5.12.7, Zod 4.6.7, better-sqlite3 13.0.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11, pino 10.4.0, esbuild 0.28.2.
- Testing and linting: Vitest 5.0.5, fast-check 4.10.2, @playwright/test 1.64.1, ESLint 10.13.0 + typescript-eslint 8.71.2.

**Spec:** `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`. This plan implements stories **FND-1 … FND-12** (§27). It relies on §6.2, §6.10, §15, §16, §17, §21 and §23.

## Global Constraints

- **Exact versions only.** Use `npm install -E`; `.npmrc` has `save-exact=true`. `npm run check:pins` must pass.
- **Platform:** Windows 10 22H2+/11. Node ≥ 24.17.0. Git for Windows ≥ 2.38 on PATH.
- **Product identity** is a placeholder pending spec Q-7. `APP_ID = 'AiKanban'` and `APP_NAME = 'AI Kanban'` exist **only** in `packages/contracts/src/app.ts`.
- **Data directory:** `%LOCALAPPDATA%\AiKanban\`. If the environment variable `AIK_DATA_DIR` is set, that path is used instead (tests and E2E always set it).
- **API:** binds `127.0.0.1` only, never `0.0.0.0`. The 256-bit token is generated per launch, lives in the Electron main process, and **is never sent to the renderer**.
- **Host header** must be `127.0.0.1:<port>` or `localhost:<port>`. An `Origin` header, if present, must equal `app://ui`.
- **Every mutation** needs an `Idempotency-Key` UUID header.
- **Error envelope:** `{ error: { code, message, retryable, details?, failedGuards? } }`. Codes per spec §17.2.
- **Story status** changes only through `WorkflowService` (`transition` / `transitionIn`). Nothing else updates `user_stories.status`.
- **Secrets** never go into the DB, logs or renderer. Every persisted string from a process, a provider, or the redactor's own inputs is redacted at write time.
- **Tests never touch a non-temporary repository.** Helpers assert that paths are under `os.tmpdir()`.
- **Renderer security:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP `script-src 'self'`. Navigation and `window.open` are denied. External links open only for allowlisted HTTPS hosts.
- **Spec deviations in this plan.** The user approves these by approving the plan:
  1. **API/SSE are proxied through the Electron main process** instead of the preload holding the token (§17.1, §6.2, S11). This is stricter: the token never enters the renderer process. The Origin rule becomes "if present, must equal `app://ui`", because main-process requests carry no Origin.
  2. Phase 1 UI uses small Tailwind primitives in `apps/ui/src/components/ui/`; shadcn/ui is adopted in Phase 2, when complex components are needed.
  3. `StoryDTO` gains `rank`, `revision` and `activePlanVersion`.
  4. `reviews` gains `actor` (`agent`|`human`) and a nullable `agent_run_id`, as already noted in the spec's §15 corrections.
  5. The renderer uses hash routing (`#/…`), so the custom protocol serves only real files.
  6. Two FND acceptance criteria are partly deferred:
     - **FND-12 AC 4** (betterleaks scan of the log directory) moves to Phase 2, when betterleaks is introduced with EXE-8. Phase 1 asserts instead that the launch token and registered secrets never appear in logs (Tasks 5 and 12).
     - **FND-2 AC 2** (an allowlisted link opens in the system browser) is covered by `isAllowedExternal` unit tests rather than E2E, because E2E can't observe the OS browser.

## Review Focus

These are uncovered inputs most likely to bite a real user. Each is pinned by a test added to the owning task.

1. **The same repository registered twice under a different spelling** (letter case, trailing `\`). The app should reject the second as a duplicate. Pinned in Task 10 (`rejects the same repo spelled differently`).
2. **A repository path with spaces and non-ASCII characters** (e.g. `…\My Repos\Zoë app`). Registration and git calls should work. Pinned in Task 10 (`accepts paths with spaces and non-ASCII`).
3. **Story search text containing SQL `LIKE` wildcards (`%`, `_`) and emoji titles.** Matching should be literal and round-trip exactly. Pinned in Task 11 (`search treats % and _ literally`).
4. **A long UI disconnect followed by a replay larger than one batch** (1,200 events). Everything should arrive in order with no gaps or duplicates. Pinned in Task 9 (`replays more than one batch in order`).
5. **A stale `statusVersion` in the UI after an orchestrator restart.** The next move should work without a manual reload, because the UI refetches when the orchestrator becomes ready. Pinned in Task 16 (`board recovers after orchestrator restart`).

---

## File Structure

```
package.json · package-lock.json · .npmrc · .gitignore · .gitattributes
tsconfig.base.json · tsconfig.json · eslint.config.js · vitest.config.ts
README.md · AGENTS.md · .github/workflows/ci.yml
scripts/check-exact-pins.ts · scripts/test/check-exact-pins.test.ts
packages/contracts/src/{app,enums,common,projects,stories,events,agents,sse,bridge,hints,index}.ts
packages/contracts/test/{schemas,sse}.test.ts
packages/workflow/src/{types,machine,drag,provenance,index}.ts
packages/workflow/test/{fixtures.ts,matrix.test.ts,guards.test.ts,properties.test.ts,drag.test.ts}
packages/db/drizzle.config.ts · packages/db/migrations/** (generated)
packages/db/src/{schema,json-types,open,backup,index}.ts
packages/db/test/{open,constraints}.test.ts
apps/orchestrator/src/
  config.ts · time.ts · app.ts · main.ts
  secrets/redactor.ts · logging/{rotating-file,logger}.ts
  events/{bus,outbox}.ts · workflow/{snapshot,service}.ts · jobs/queue.ts
  api/{errors,security,idempotency,server}.ts · api/routes/{health,projects,stories,events}.ts
  git/git.ts · projects/service.ts · stories/{service,dto}.ts
apps/orchestrator/test/helpers/{temp,db,app}.ts + *.test.ts
apps/desktop/src/main/{index,window,protocol,ui-path,links,bridge,supervisor,backoff,events-forwarder,paths}.ts
apps/desktop/src/preload/index.ts · apps/desktop/scripts/{build,dev}.mjs · apps/desktop/test/*.test.ts
apps/ui/{index.html,vite.config.ts} · apps/ui/src/{main.tsx,router.tsx,index.css,vite-env.d.ts}
apps/ui/src/lib/{api,events,stories,transitions,theme}.ts
apps/ui/src/components/ui/{button,badge,dialog,field,toast}.tsx
apps/ui/src/components/kanban/{board,column,card,move-menu,create-story-dialog,request-changes-dialog}.tsx
apps/ui/src/routes/{root,dashboard,board,settings}.tsx
e2e/{playwright.config.ts,fixtures.ts} · e2e/tests/{dashboard,board,security,lifecycle}.spec.ts
```

---

### Task 1: Monorepo scaffold, toolchain pins, CI (FND-1)

**Files:**
- Create: `package.json`, `.npmrc`, `.gitattributes`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `README.md`, `AGENTS.md`, `.github/workflows/ci.yml`
- Create: `scripts/check-exact-pins.ts`, `scripts/test/check-exact-pins.test.ts`
- Modify: `.gitignore` (created in Phase 0 Task 1; create it now if Phase 0 hasn't run)

**Interfaces:**
- Produces:
  - root scripts `check:pins`, `lint`, `typecheck`, `test`;
  - `findLooseRanges(manifest: Record<string, unknown>, file: string): string[]`;
  - `listManifests(root: string): string[]`;
  - the npm workspaces `packages/*` and `apps/*`, each package named `@aik/<name>` at version `0.0.0`, consumed as TypeScript source via `"exports": { ".": "./src/index.ts" }`.

- [ ] **Step 1: Create the root manifest and npm settings**

```json
// package.json
{
  "name": "ai-kanban-automation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=24.17.0" },
  "scripts": {
    "check:pins": "node scripts/check-exact-pins.ts",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "24.19.2",
    "eslint": "10.13.0",
    "globals": "17.13.0",
    "typescript": "6.0.3",
    "typescript-eslint": "8.71.2",
    "vitest": "5.0.5"
  }
}
```

```ini
# .npmrc
save-exact=true
engine-strict=true
```

```gitattributes
# .gitattributes
* text=auto
*.ps1 text eol=crlf
```

Append to `.gitignore` (create it if missing):

```gitignore
node_modules/
dist/
*.log
coverage/
e2e/test-results/
e2e/playwright-report/
apps/desktop/dist/
apps/ui/dist/
spikes/**/node_modules/
spikes/**/out/
spikes/**/runtime/
spikes/**/*.exe
.env*
```

- [ ] **Step 2: Create TypeScript, ESLint and Vitest configuration**

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

```json
// tsconfig.json
{
  "extends": "./tsconfig.base.json",
  "include": [
    "scripts",
    "packages/*/src", "packages/*/test", "packages/*/*.config.ts",
    "apps/*/src", "apps/*/test", "apps/*/*.config.ts",
    "e2e",
    "vitest.config.ts"
  ]
}
```

```js
// eslint.config.js
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', 'packages/db/migrations/**', 'spikes/**',
      'e2e/test-results/**', 'e2e/playwright-report/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 3: Write the failing test for the pin checker**

```ts
// scripts/test/check-exact-pins.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLooseRanges, listManifests } from '../check-exact-pins.ts';

describe('findLooseRanges', () => {
  it('accepts exact versions and prereleases', () => {
    expect(findLooseRanges({ dependencies: { a: '1.2.3', b: '2.0.0-rc.1' } }, 'p')).toEqual([]);
  });

  it('rejects ranges, tags and wildcards', () => {
    const found = findLooseRanges({ dependencies: { a: '^1.2.3', b: '~1.0.0', c: 'latest', d: '*', e: '>=1' } }, 'p');
    expect(found).toHaveLength(5);
  });

  it('checks dev and optional dependencies but not peers', () => {
    const found = findLooseRanges(
      { devDependencies: { a: '^1.0.0' }, optionalDependencies: { b: '1.x' }, peerDependencies: { c: '^1.0.0' } },
      'p',
    );
    expect(found).toEqual(['p: devDependencies.a = "^1.0.0"', 'p: optionalDependencies.b = "1.x"']);
  });
});

describe('listManifests', () => {
  it('finds the root, apps and packages manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-pins-'));
    for (const dir of ['apps/x', 'packages/y']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'package.json'), '{}');
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const rel = listManifests(root).map((f) => path.relative(root, f)).sort();
    expect(rel).toEqual([path.join('apps', 'x', 'package.json'), 'package.json', path.join('packages', 'y', 'package.json')].sort());
  });
});
```

- [ ] **Step 4: Install and run the test to verify it fails**

Run: `npm install`
Then run: `npx vitest run scripts/test/check-exact-pins.test.ts`
Expected: FAIL with "Failed to load url ../check-exact-pins.ts" (the file doesn't exist yet).

- [ ] **Step 5: Implement the pin checker**

```ts
// scripts/check-exact-pins.ts
// Fails when any workspace manifest declares a dependency with a non-exact version.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export function findLooseRanges(manifest: Record<string, unknown>, file: string): string[] {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (!EXACT.test(spec)) problems.push(`${file}: ${section}.${name} = "${spec}"`);
    }
  }
  return problems;
}

export function listManifests(root: string): string[] {
  const files = [path.join(root, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'package.json');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(import.meta.dirname, '..');
  const problems = listManifests(root).flatMap((file) =>
    findLooseRanges(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>, path.relative(root, file)),
  );
  if (problems.length > 0) {
    console.error(`Non-exact dependency versions found:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('All dependency versions are exact.');
}
```

- [ ] **Step 6: Run the tests and all root checks**

Run: `npx vitest run scripts/test/check-exact-pins.test.ts`
Expected: PASS (4 tests).
Then run: `npm run check:pins && npm run lint && npm run typecheck && npm test`
Expected: `All dependency versions are exact.`, no lint errors, no type errors, and the tests pass.

- [ ] **Step 7: Add the README, AGENTS.md and CI**

```markdown
<!-- README.md -->
# AI Kanban (working name)

Local-first Windows desktop app: you write user stories on a Kanban board; AI agents plan, implement,
test, review and rework them; you approve plans and merges. DONE requires evidence.

- Design spec: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`
- Implementation plans: `docs/superpowers/plans/`

## Requirements
Windows 10 22H2+ / 11 · Node ≥ 24.17.0 · Git for Windows ≥ 2.38

## Commands
| Command | Purpose |
|---|---|
| `npm ci` | install exact dependencies |
| `npm run check:pins` | fail on non-exact dependency versions |
| `npm run lint` · `npm run typecheck` · `npm test` | static checks and unit/integration tests |
```

```markdown
<!-- AGENTS.md -->
# Instructions for AI agents working in this repository

- Read the spec first: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`; the active plan is in `docs/superpowers/plans/`.
- Dependencies use exact versions only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`, which asserts paths are under the OS temp directory.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly.
- Code under `spikes/` is throwaway; never import it.
```

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24.17.0
          cache: npm
      - run: npm ci
      - run: npm run check:pins
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .npmrc .gitattributes .gitignore tsconfig.base.json tsconfig.json eslint.config.js vitest.config.ts README.md AGENTS.md .github scripts
git commit -m "chore: monorepo scaffold with exact pins, lint, typecheck, tests and CI"
```

---

### Task 2: Shared contracts (part of FND-4)

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/app.ts`, `enums.ts`, `common.ts`, `projects.ts`, `stories.ts`, `events.ts`, `agents.ts`, `sse.ts`, `bridge.ts`, `hints.ts`, `index.ts`
- Test: `packages/contracts/test/schemas.test.ts`, `packages/contracts/test/sse.test.ts`

**Interfaces:**
- Produces, all exported from `@aik/contracts`:
  - Identity: `APP_ID`, `APP_NAME`, `UI_ORIGIN`.
  - Status enums: `STORY_STATUS`/`StoryStatus`, `TERMINAL_STATUSES`, `ACTIVE_STATUSES`, `RESUMABLE_STATUSES`, `isTerminal(s)`.
  - Other enums: `PLANNING_STATUS`/`PlanningStatus`, `BLOCKED_REASON`/`BlockedReason`, `ROLE`/`Role`, `PRIORITY`/`Priority`, `COMPLEXITY`/`Complexity`, `PLAN_STATUS`, `VERDICT`/`Verdict`.
  - Errors and primitives: `Sha`, `ERROR_CODES`, `ErrorCode`, `FailedGuard`, `ApiError`, `IdempotencyKey`.
  - Projects: `CheckConfig`, `ProjectSettings` (with `defaultProjectSettings()`), `ProjectKey`, `ProjectDTO`, `CreateProjectRequest`, `PatchProjectRequest`.
  - Stories: `AcceptanceCriterionDTO`, `StoryDTO`, `CreateStoryRequest`, `PatchStoryRequest`, `StoryListQuery`, `STORY_SORTS`, `HUMAN_EVENTS`, `TransitionRequest`.
  - Events: `EVENT_TOPICS`/`EventTopic`, `PROVENANCE`/`Provenance`, `EventEnvelope`.
  - Agent output: `PlanV1`, `ReviewV1`.
  - SSE and bridge: `createSseParser(onMessage)`, `formatSse(msg)`, `SseMessage`, `AikWindowApi`, `SystemState`, `OrchestratorState`, `BridgeResponse`, `HttpMethod`.
  - Hints: `BLOCKED_HINTS`.
  - Every Zod schema also has a same-named inferred type.

- [ ] **Step 1: Create the package**

```json
// packages/contracts/package.json
{
  "name": "@aik/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "4.6.7" }
}
```

Run: `npm install`
Expected: `zod@4.6.7` is added to the lockfile and `node_modules/@aik/contracts` links to the package.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/contracts/test/schemas.test.ts
import { describe, expect, it } from 'vitest';
import {
  CreateStoryRequest, PatchProjectRequest, ProjectKey, Sha, StoryListQuery, TransitionRequest,
  defaultProjectSettings,
} from '../src/index.ts';

describe('Sha', () => {
  it('accepts 40- and 64-hex lowercase SHAs', () => {
    expect(Sha.safeParse('a'.repeat(40)).success).toBe(true);
    expect(Sha.safeParse('b'.repeat(64)).success).toBe(true);
  });
  it('rejects other lengths, uppercase and non-hex', () => {
    for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)]) {
      expect(Sha.safeParse(bad).success).toBe(false);
    }
  });
});

describe('ProjectSettings', () => {
  it('fills nested defaults from an empty object', () => {
    const s = defaultProjectSettings();
    expect(s.maxAttempts).toBe(3);
    expect(s.budgets).toEqual({ requestsPerRun: 300, requestsPerStory: 1000, inputTokensPerStory: 3_000_000 });
    expect(s.jobLimits).toEqual({ memoryMb: 4096, maxProcesses: 64 });
    expect(s.protectedPaths).toContain('.github/workflows/**');
    expect(s.publish).toBe(false);
    expect(s.allowPaid).toBe(false);
  });
  it('rejects unknown keys in a project patch', () => {
    expect(PatchProjectRequest.safeParse({ name: 'x', bogus: 1 }).success).toBe(false);
  });
});

describe('ProjectKey', () => {
  it('requires 2–10 uppercase letters/digits starting with a letter', () => {
    expect(ProjectKey.safeParse('INV').success).toBe(true);
    for (const bad of ['I', 'inv', '1NV', 'INVENTORY12']) expect(ProjectKey.safeParse(bad).success).toBe(false);
  });
});

describe('CreateStoryRequest', () => {
  it('applies defaults and trims', () => {
    const r = CreateStoryRequest.parse({ title: '  Inventory  ' });
    expect(r).toEqual({ title: 'Inventory', description: '', acceptanceCriteria: [], priority: 'P2', labels: [], dependsOn: [] });
  });
  it('is strict about unknown keys', () => {
    expect(CreateStoryRequest.safeParse({ title: 'x', status: 'DONE' }).success).toBe(false);
  });
});

describe('StoryListQuery', () => {
  it('defaults sort to rank', () => {
    expect(StoryListQuery.parse({}).sort).toBe('rank');
  });
});

describe('TransitionRequest', () => {
  it('parses each human event with expectedVersion', () => {
    expect(TransitionRequest.parse({ event: 'cancel', expectedVersion: 2 })).toEqual({ event: 'cancel', expectedVersion: 2 });
    expect(TransitionRequest.parse({ event: 'recover', target: 'resume', expectedVersion: 0 })).toMatchObject({ target: 'resume' });
    expect(TransitionRequest.parse({ event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 5 })).toMatchObject({ sha: 'a'.repeat(40) });
  });
  it('rejects missing expectedVersion, unknown events and bad payloads', () => {
    expect(TransitionRequest.safeParse({ event: 'cancel' }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'mark_done', expectedVersion: 1 }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'request_changes', sha: 'a'.repeat(40), findings: [], expectedVersion: 1 }).success).toBe(false);
    expect(TransitionRequest.safeParse({ event: 'recover', target: 'DONE', expectedVersion: 1 }).success).toBe(false);
  });
});
```

```ts
// packages/contracts/test/sse.test.ts
import { describe, expect, it } from 'vitest';
import { createSseParser, formatSse, type SseMessage } from '../src/index.ts';

function collect(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const feed = createSseParser((m) => out.push(m));
  for (const c of chunks) feed(c);
  return out;
}

describe('createSseParser', () => {
  it('parses a complete message', () => {
    expect(collect(['id: 7\ndata: {"a":1}\n\n'])).toEqual([{ id: '7', event: 'message', data: '{"a":1}' }]);
  });
  it('handles messages split across arbitrary chunk boundaries', () => {
    const text = 'id: 1\ndata: hello\n\nid: 2\ndata: world\n\n';
    const chunks = text.split('');
    expect(collect(chunks).map((m) => [m.id, m.data])).toEqual([['1', 'hello'], ['2', 'world']]);
  });
  it('ignores comments (heartbeats) and joins multi-line data', () => {
    expect(collect([': hb\n\ndata: a\ndata: b\n\n'])).toEqual([{ id: null, event: 'message', data: 'a\nb' }]);
  });
  it('does not dispatch early when a CRLF is split between chunks', () => {
    const out = collect(['data: x\r', '\n\r', '\n']);
    expect(out).toEqual([{ id: null, event: 'message', data: 'x' }]);
  });
});

describe('formatSse', () => {
  it('round-trips through the parser', () => {
    const wire = formatSse({ id: 42, data: '{"x":"line1\\nline2"}' });
    expect(collect([wire])).toEqual([{ id: '42', event: 'message', data: '{"x":"line1\\nline2"}' }]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/contracts`
Expected: FAIL with "Failed to load url ../src/index.ts".

- [ ] **Step 4: Implement the contracts**

```ts
// packages/contracts/src/app.ts
/** Working product identity — placeholder until spec Q-7 is answered. Rename here only. */
export const APP_ID = 'AiKanban';
export const APP_NAME = 'AI Kanban';
/** Origin of the packaged renderer (custom protocol `app://ui`). */
export const UI_ORIGIN = 'app://ui';
```

```ts
// packages/contracts/src/enums.ts
export const STORY_STATUS = [
  'NEW', 'READY', 'IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'BLOCKED', 'AWAITING_MERGE', 'DONE', 'CANCELLED',
] as const;
export type StoryStatus = (typeof STORY_STATUS)[number];

export const TERMINAL_STATUSES: readonly StoryStatus[] = ['DONE', 'CANCELLED'];
export const ACTIVE_STATUSES: readonly StoryStatus[] = ['IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'];
export const RESUMABLE_STATUSES: readonly StoryStatus[] = ['TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'];
export const isTerminal = (s: StoryStatus): boolean => TERMINAL_STATUSES.includes(s);

export const PLANNING_STATUS = ['none', 'planning', 'needs_clarification', 'plan_proposed', 'plan_approved', 'planning_failed'] as const;
export type PlanningStatus = (typeof PLANNING_STATUS)[number];

export const BLOCKED_REASON = [
  'retry_limit', 'no_progress', 'quota', 'provider_down', 'auth', 'conflict', 'permission_denied',
  'reviewer_blocked', 'post_merge_failed', 'interrupted', 'invalid_agent_output', 'model_limit', 'environment',
] as const;
export type BlockedReason = (typeof BLOCKED_REASON)[number];

export const ROLE = ['planner', 'implementer', 'reviewer'] as const;
export type Role = (typeof ROLE)[number];

export const PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITY)[number];

export const COMPLEXITY = ['S', 'M', 'L', 'XL'] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const PLAN_STATUS = ['proposed', 'approved', 'rejected', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const VERDICT = ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] as const;
export type Verdict = (typeof VERDICT)[number];
```

```ts
// packages/contracts/src/common.ts
import { z } from 'zod';

export const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a 40- or 64-hex lowercase commit SHA');

export const ERROR_CODES = [
  'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN_ORIGIN', 'NOT_FOUND', 'VERSION_CONFLICT',
  'GUARD_FAILED', 'IDEMPOTENCY_MISMATCH', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FailedGuard = z.object({ guard: z.string(), reason: z.string() });
export type FailedGuard = z.infer<typeof FailedGuard>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
    failedGuards: z.array(FailedGuard).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const IdempotencyKey = z.uuid();
```

```ts
// packages/contracts/src/projects.ts
import { z } from 'zod';

export const CheckConfig = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  command: z.string().min(1).max(500),
  mandatory: z.boolean(),
  timeoutSec: z.number().int().min(1).max(7200).default(900),
});
export type CheckConfig = z.infer<typeof CheckConfig>;

export const ProjectSettings = z.object({
  checks: z.array(CheckConfig).default([]),
  shellAllowlist: z.array(z.string().min(1).max(200)).default([]),
  protectedPaths: z
    .array(z.string().min(1).max(200))
    .default(['.github/workflows/**', '.opencode/**', 'opencode.json*', '.husky/**', '.gitmodules', '.gitattributes']),
  publish: z.boolean().default(false),
  remoteMerge: z.boolean().default(false),
  requireRemoteChecks: z.boolean().default(true),
  autoAcceptPlans: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  allowPaid: z.boolean().default(false),
  allowMayTrain: z.boolean().default(false),
  webfetch: z.boolean().default(false),
  mergeMethod: z.enum(['merge', 'squash']).default('merge'),
  // Zod 4: `.prefault({})` runs the default through the schema so nested defaults apply.
  budgets: z
    .object({
      requestsPerRun: z.number().int().min(1).default(300),
      requestsPerStory: z.number().int().min(1).default(1000),
      inputTokensPerStory: z.number().int().min(1).default(3_000_000),
    })
    .prefault({}),
  jobLimits: z
    .object({
      memoryMb: z.number().int().min(256).default(4096),
      maxProcesses: z.number().int().min(4).default(64),
    })
    .prefault({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export const defaultProjectSettings = (): ProjectSettings => ProjectSettings.parse({});

export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Project key: 2–10 uppercase letters/digits, starting with a letter');

export const ProjectDTO = z.object({
  id: z.number().int(),
  key: z.string(),
  name: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  remoteUrl: z.string().nullable(),
  status: z.enum(['active', 'unavailable', 'archived']),
  settings: ProjectSettings,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectDTO = z.infer<typeof ProjectDTO>;

export const CreateProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    key: ProjectKey,
    repoPath: z.string().min(1).max(1000),
    baseBranch: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `settings` replaces the stored settings wholesale (send the full object). */
export const PatchProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    baseBranch: z.string().min(1).max(200).optional(),
    settings: ProjectSettings.optional(),
  })
  .strict();
export type PatchProjectRequest = z.infer<typeof PatchProjectRequest>;
```

```ts
// packages/contracts/src/stories.ts
import { z } from 'zod';
import { Sha } from './common.ts';
import { BLOCKED_REASON, COMPLEXITY, PLANNING_STATUS, PRIORITY, ROLE, STORY_STATUS } from './enums.ts';

export const AcceptanceCriterionDTO = z.object({ id: z.number().int(), ordinal: z.number().int(), text: z.string() });
export type AcceptanceCriterionDTO = z.infer<typeof AcceptanceCriterionDTO>;

export const StoryDTO = z.object({
  id: z.number().int(),
  key: z.string(),
  projectId: z.number().int(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(PRIORITY),
  rank: z.number().int(),
  labels: z.array(z.string()),
  complexity: z.enum(COMPLEXITY).nullable(),
  revision: z.number().int(),
  status: z.enum(STORY_STATUS),
  statusVersion: z.number().int(),
  planningStatus: z.enum(PLANNING_STATUS),
  activePlanVersion: z.number().int().nullable(),
  hold: z.boolean(),
  blocked: z
    .object({ reason: z.enum(BLOCKED_REASON), from: z.enum(STORY_STATUS).nullable(), detail: z.string(), hint: z.string() })
    .nullable(),
  attempts: z.object({ used: z.number().int(), max: z.number().int() }),
  acceptanceCriteria: z.array(AcceptanceCriterionDTO),
  dependsOn: z.array(z.string()),
  branch: z.string().nullable(),
  candidateSha: z.string().nullable(),
  mergedSha: z.string().nullable(),
  activeRun: z.object({ id: z.number().int(), role: z.enum(ROLE), model: z.string(), startedAt: z.number() }).nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string(), state: z.string() }).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoryDTO = z.infer<typeof StoryDTO>;

const Title = z.string().trim().min(1).max(200);
const Description = z.string().max(20_000);
const Criterion = z.string().trim().min(1).max(2000);
const Label = z.string().trim().min(1).max(40);
const StoryKeyRef = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/);

export const CreateStoryRequest = z
  .object({
    title: Title,
    description: Description.default(''),
    acceptanceCriteria: z.array(Criterion).max(50).default([]),
    priority: z.enum(PRIORITY).default('P2'),
    labels: z.array(Label).max(20).default([]),
    dependsOn: z.array(StoryKeyRef).max(50).default([]),
  })
  .strict();
export type CreateStoryRequest = z.infer<typeof CreateStoryRequest>;

export const PatchStoryRequest = z
  .object({
    expectedVersion: z.number().int().min(0),
    title: Title.optional(),
    description: Description.optional(),
    acceptanceCriteria: z.array(Criterion).max(50).optional(),
    priority: z.enum(PRIORITY).optional(),
    labels: z.array(Label).max(20).optional(),
    rank: z.number().int().optional(),
    dependsOn: z.array(StoryKeyRef).max(50).optional(),
  })
  .strict();
export type PatchStoryRequest = z.infer<typeof PatchStoryRequest>;

export const STORY_SORTS = ['rank', 'priority', 'updated', 'created'] as const;
export const StoryListQuery = z.object({
  status: z.string().max(400).optional(),
  label: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(STORY_SORTS).default('rank'),
});
export type StoryListQuery = z.infer<typeof StoryListQuery>;

export const HUMAN_EVENTS = [
  'approve_plan', 'reject_plan', 'answer_clarifications', 'request_changes', 'approve_publish', 'approve_merge',
  'override_remote_review', 'recover', 'cancel', 'hold', 'unhold', 'stop_run',
] as const;
export type HumanEvent = (typeof HUMAN_EVENTS)[number];

const PlanVersion = z.number().int().min(1);
export const TransitionRequest = z
  .discriminatedUnion('event', [
    z.object({ event: z.literal('approve_plan'), planVersion: PlanVersion }),
    z.object({ event: z.literal('reject_plan'), planVersion: PlanVersion, feedback: z.string().trim().min(1).max(5000) }),
    z.object({
      event: z.literal('answer_clarifications'),
      planVersion: PlanVersion,
      answers: z.array(z.object({ ordinal: z.number().int().min(1), answer: z.string().trim().min(1).max(5000) })).min(1),
    }),
    z.object({
      event: z.literal('request_changes'),
      sha: Sha,
      findings: z.array(z.object({ text: z.string().trim().min(1).max(5000), file: z.string().max(500).optional() })).min(1),
    }),
    z.object({ event: z.literal('approve_publish'), sha: Sha }),
    z.object({ event: z.literal('approve_merge'), sha: Sha, method: z.enum(['merge', 'squash']).optional() }),
    z.object({ event: z.literal('override_remote_review'), sha: Sha, note: z.string().trim().min(1).max(2000) }),
    z.object({ event: z.literal('recover'), target: z.enum(['READY', 'NEW', 'resume']), extraAttempts: z.number().int().min(0).max(5).optional() }),
    z.object({ event: z.literal('cancel') }),
    z.object({ event: z.literal('hold') }),
    z.object({ event: z.literal('unhold') }),
    z.object({ event: z.literal('stop_run') }),
  ])
  .and(z.object({ expectedVersion: z.number().int().min(0) }));
export type TransitionRequest = z.infer<typeof TransitionRequest>;
```

```ts
// packages/contracts/src/events.ts
import { z } from 'zod';

export const EVENT_TOPICS = [
  'story.transitioned', 'story.updated', 'run.started', 'run.output', 'run.finished', 'check.started', 'check.finished',
  'review.completed', 'pr.updated', 'provider.quota', 'github.connection', 'system.health', 'system.resync',
] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

export const PROVENANCE = [
  'agent_reported', 'command_completed', 'check_verified', 'review_decision', 'human_approval', 'completion', 'system',
] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const EventEnvelope = z.object({
  seq: z.number().int(),
  topic: z.enum(EVENT_TOPICS),
  storyId: z.number().int().nullable(),
  at: z.number(),
  provenance: z.enum(PROVENANCE),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
```

```ts
// packages/contracts/src/agents.ts
import { z } from 'zod';

export const PlanV1 = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1),
  assumptions: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({ ref: z.string(), text: z.string(), testable: z.boolean(), verification: z.string() })),
  subtasks: z.array(z.object({ id: z.string(), description: z.string(), files: z.array(z.string()) })).min(1),
  affectedFiles: z.array(z.string()),
  requiredTests: z.array(z.string()),
  migrations: z.object({ required: z.boolean(), notes: z.string() }),
  securitySensitive: z.array(z.string()),
  dependencyChanges: z.array(z.string()),
  conflictsWith: z.array(z.string()),
  complexity: z.enum(['S', 'M', 'L', 'XL']),
  risks: z.array(z.string()),
});
export type PlanV1 = z.infer<typeof PlanV1>;

export const ReviewV1 = z.object({
  schemaVersion: z.literal(1),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']),
  summary: z.string(),
  acChecklist: z.array(z.object({ acRef: z.string(), status: z.enum(['met', 'unmet', 'unclear']), evidence: z.string() })),
  findings: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      category: z.enum([
        'correctness', 'missing_requirement', 'regression', 'security', 'validation', 'data_integrity', 'error_handling',
        'edge_case', 'tests', 'performance', 'duplication', 'dependency', 'unsafe_operation', 'other',
      ]),
      file: z.string().optional(),
      lineStart: z.number().int().optional(),
      lineEnd: z.number().int().optional(),
      evidence: z.string(),
      explanation: z.string(),
      recommendation: z.string(),
      blocking: z.boolean(),
    }),
  ),
  priorFindings: z.array(z.object({ id: z.string(), status: z.enum(['resolved', 'unresolved', 'disputed']), note: z.string() })),
  blockedReason: z.string().optional(),
});
export type ReviewV1 = z.infer<typeof ReviewV1>;
```

```ts
// packages/contracts/src/sse.ts
export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parser (WHATWG field rules; comments ignored). */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let id: string | null = null;
  let event = 'message';
  let data: string[] = [];
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.search(/\r\n|\n|\r/);
      if (nl < 0) break;
      // A trailing lone '\r' may be the first half of '\r\n' — wait for the next chunk.
      if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
      const width = buffer.startsWith('\r\n', nl) ? 2 : 1;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + width);
      if (line === '') {
        if (data.length > 0) onMessage({ id, event, data: data.join('\n') });
        event = 'message';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
    }
  };
}

export function formatSse(message: { id?: string | number; event?: string; data: string }): string {
  let out = '';
  if (message.id !== undefined) out += `id: ${message.id}\n`;
  if (message.event !== undefined) out += `event: ${message.event}\n`;
  for (const line of message.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}
```

```ts
// packages/contracts/src/bridge.ts
import type { EventEnvelope } from './events.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface BridgeResponse {
  status: number;
  body: unknown;
}
export type OrchestratorState = 'starting' | 'ready' | 'restarting' | 'crash-loop' | 'fatal' | 'stopped';
export interface SystemState {
  state: OrchestratorState;
  fatal: { kind: 'database_corrupt' | 'startup_failed'; message: string } | null;
}

/** The only API the renderer can reach (exposed by the preload as `window.api`). */
export interface AikWindowApi {
  request(method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string): Promise<BridgeResponse>;
  pickDirectory(): Promise<string | null>;
  systemState(): Promise<SystemState>;
  restoreLatestBackup(): Promise<{ ok: true; restoredFrom: string } | { ok: false; reason: string }>;
  restartOrchestrator(): Promise<void>;
  events: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  system: { subscribe(listener: (state: SystemState) => void): () => void };
}
```

```ts
// packages/contracts/src/hints.ts
import type { BlockedReason } from './enums.ts';

/** Human-readable recovery hints for each BLOCKED reason (spec §16.5). */
export const BLOCKED_HINTS: Record<BlockedReason, string> = {
  retry_limit: 'The attempt budget is used up. Review the last findings, then edit the plan or grant extra attempts.',
  no_progress: 'The last repair produced an identical result. Re-plan or edit the story.',
  quota: 'The model provider quota is exhausted. Resume after it resets or enable another provider.',
  provider_down: 'The model provider is unavailable. Resume when it is back.',
  auth: 'Credentials expired or were revoked. Reconnect, then resume.',
  conflict: 'A merge conflict needs resolution. Resolve it in the worktree, then resume.',
  permission_denied: 'An agent action was denied by project policy. Adjust the policy if appropriate, then recover.',
  reviewer_blocked: 'The reviewer blocked this change. Re-plan or request specific changes.',
  post_merge_failed: 'Checks failed after merging. Consider reverting and creating a follow-up story.',
  interrupted: 'Work was interrupted (restart or stop). Resume to continue.',
  invalid_agent_output: 'The agent returned output that failed validation. Retry or switch models.',
  model_limit: 'The prompt exceeds the model context. Choose a larger-context model.',
  environment: 'A required tool, disk space, or the repository path is unavailable. Fix it, then resume.',
};
```

```ts
// packages/contracts/src/index.ts
export * from './agents.ts';
export * from './app.ts';
export * from './bridge.ts';
export * from './common.ts';
export * from './enums.ts';
export * from './events.ts';
export * from './hints.ts';
export * from './projects.ts';
export * from './sse.ts';
export * from './stories.ts';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/contracts`
Expected: PASS (all tests in `schemas.test.ts` and `sse.test.ts`).

- [ ] **Step 6: Run the static checks**

Run: `npm run check:pins && npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts package.json package-lock.json
git commit -m "feat(contracts): shared enums, Zod API schemas, SSE codec and window bridge types"
```

---

### Task 3: Pure workflow state machine (FND-6, part 1)

**Files:**
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/src/types.ts`, `machine.ts`, `drag.ts`, `provenance.ts`, `index.ts`
- Test: `packages/workflow/test/fixtures.ts`, `matrix.test.ts`, `guards.test.ts`, `properties.test.ts`, `drag.test.ts`

**Interfaces:**
- Consumes: `@aik/contracts` enums, `FailedGuard`, `Provenance`.
- Produces, exported from `@aik/workflow`:
  - `evaluate(story: StorySnapshot, evidence: Evidence, event: WorkflowEvent): TransitionResult`.
  - Types: `StorySnapshot`, `PlanEvidence`, `Evidence`, `WorkflowEvent`, `EventType`, `EVENT_TYPES`, `StoryPatch`, `Effect`, `TransitionId`, `TransitionResult`.
  - `dragVerdict(story: DragStory, to: StoryStatus): DragVerdict` and `DragTarget`.
  - `provenanceFor(eventType: EventType, to: StoryStatus): Provenance`.

- [ ] **Step 1: Create the package**

```json
// packages/workflow/package.json
{
  "name": "@aik/workflow",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@aik/contracts": "0.0.0" }
}
```

Run: `npm install -E -D fast-check@4.10.2`, then `npm install`
Expected: `fast-check` is in the root devDependencies and `@aik/workflow` is linked.

- [ ] **Step 2: Write the types (needed by tests and implementation)**

```ts
// packages/workflow/src/types.ts
import type { BlockedReason, FailedGuard, PlanStatus, PlanningStatus, StoryStatus, Verdict } from '@aik/contracts';

export type TransitionId =
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17'
  | 'EDIT' | 'HOLD' | 'UNHOLD';

export interface StorySnapshot {
  status: StoryStatus;
  planningStatus: PlanningStatus;
  hold: boolean;
  revision: number;
  attemptCount: number;
  maxAttempts: number;
  candidateSha: string | null;
  candidateTree: string | null;
  blockedFrom: StoryStatus | null;
  blockedReason: BlockedReason | null;
  activeRunId: number | null;
  title: string;
  description: string;
  currentAcceptanceCriteria: number;
}

export interface PlanEvidence {
  version: number;
  status: PlanStatus;
  storyRevision: number;
  openClarifications: number;
}

/** Facts loaded from the database; the state machine never trusts agent claims. */
export interface Evidence {
  plan: PlanEvidence | null;
  dependenciesDone: boolean;
  mergeInProgress: boolean;
  /** Latest completed candidate verification for story.candidateSha. */
  verification: { sha: string; mandatoryAllPassed: boolean } | null;
  /** Latest agent review for story.candidateSha (already normalized). */
  review: { sha: string; verdict: Verdict; blockingFindings: number; allAcMet: boolean } | null;
  mergeApprovalForCandidate: boolean;
  merge: { succeeded: boolean; mergedSha: string | null; containsCandidate: boolean } | null;
  postMergeVerificationPassed: boolean;
}

export type WorkflowEvent =
  | { type: 'approve_plan'; planVersion: number }
  | { type: 'auto_accept_plan'; planVersion: number }
  | { type: 'edit_definition' }
  | { type: 'claim_implement'; runId: number; leaseHeld: boolean; worktreeReady: boolean }
  | { type: 'candidate_committed'; runId: number; candidateSha: string; candidateTree: string; diffEmpty: boolean; treeAlreadyRejected: boolean }
  | { type: 'verification_passed'; sha: string }
  | { type: 'review_approved'; sha: string }
  | { type: 'review_changes_requested'; sha: string }
  | { type: 'merge_completed'; mergedSha: string }
  | { type: 'candidate_head_changed'; newSha: string; newTree: string }
  | { type: 'request_changes'; sha: string }
  | { type: 'merge_conflict' }
  | { type: 'fail'; reason: BlockedReason; detail: string }
  | { type: 'stop_run' }
  | { type: 'recover'; target: 'READY' | 'NEW' | 'resume'; extraAttempts: number; causeResolved: boolean }
  | { type: 'cancel' }
  | { type: 'hold' }
  | { type: 'unhold' };

export type EventType = WorkflowEvent['type'];

export const EVENT_TYPES: readonly EventType[] = [
  'approve_plan', 'auto_accept_plan', 'edit_definition', 'claim_implement', 'candidate_committed', 'verification_passed',
  'review_approved', 'review_changes_requested', 'merge_completed', 'candidate_head_changed', 'request_changes',
  'merge_conflict', 'fail', 'stop_run', 'recover', 'cancel', 'hold', 'unhold',
];

export interface StoryPatch {
  status?: StoryStatus;
  planningStatus?: PlanningStatus;
  hold?: boolean;
  revision?: number;
  attemptCount?: number;
  maxAttempts?: number;
  candidateSha?: string | null;
  candidateTree?: string | null;
  blockedReason?: BlockedReason | null;
  blockedFrom?: StoryStatus | null;
  blockedDetail?: string | null;
  activeRunId?: number | null;
  mergedSha?: string | null;
}

export type Effect =
  | { kind: 'approve_plan'; planVersion: number; by: 'human' | 'auto' }
  | { kind: 'supersede_plan' }
  | { kind: 'interrupt_active_run'; runId: number }
  | { kind: 'cancel_jobs' };

export type TransitionResult =
  | { ok: true; id: TransitionId; from: StoryStatus; to: StoryStatus; patch: StoryPatch; effects: Effect[] }
  | { ok: false; failedGuards: FailedGuard[] };
```

- [ ] **Step 3: Write the fixtures and the failing matrix test**

```ts
// packages/workflow/test/fixtures.ts
import type { StoryStatus } from '@aik/contracts';
import type { EventType, Evidence, StorySnapshot, WorkflowEvent } from '../src/index.ts';

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const TREE_A = 'c'.repeat(40);
export const TREE_B = 'd'.repeat(40);

export function story(overrides: Partial<StorySnapshot> = {}): StorySnapshot {
  return {
    status: 'NEW', planningStatus: 'plan_proposed', hold: false, revision: 1, attemptCount: 0, maxAttempts: 3,
    candidateSha: SHA_A, candidateTree: TREE_A, blockedFrom: null, blockedReason: null, activeRunId: null,
    title: 'Inventory', description: 'CRUD for inventory', currentAcceptanceCriteria: 1,
    ...overrides,
  };
}

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    plan: { version: 1, status: 'proposed', storyRevision: 1, openClarifications: 0 },
    dependenciesDone: true,
    mergeInProgress: false,
    verification: { sha: SHA_A, mandatoryAllPassed: true },
    review: { sha: SHA_A, verdict: 'APPROVED', blockingFindings: 0, allAcMet: true },
    mergeApprovalForCandidate: true,
    merge: { succeeded: true, mergedSha: SHA_B, containsCandidate: true },
    postMergeVerificationPassed: true,
    ...overrides,
  };
}

/** A story/evidence/event triple in which every guard except the state guard is satisfied. */
export function satisfying(type: EventType, status: StoryStatus): { story: StorySnapshot; evidence: Evidence; event: WorkflowEvent } {
  const s = story({ status, blockedReason: status === 'BLOCKED' ? 'quota' : null, blockedFrom: status === 'BLOCKED' ? 'TESTING' : null });
  const e = evidence();
  switch (type) {
    case 'approve_plan':
    case 'auto_accept_plan':
      return { story: s, evidence: e, event: { type, planVersion: 1 } };
    case 'edit_definition':
      return { story: s, evidence: e, event: { type } };
    case 'claim_implement':
      return {
        story: s,
        evidence: status === 'TESTING' ? evidence({ verification: { sha: SHA_A, mandatoryAllPassed: false } }) : e,
        event: { type, runId: 7, leaseHeld: true, worktreeReady: true },
      };
    case 'candidate_committed':
      return { story: { ...s, activeRunId: 7 }, evidence: e, event: { type, runId: 7, candidateSha: SHA_B, candidateTree: TREE_B, diffEmpty: false, treeAlreadyRejected: false } };
    case 'verification_passed':
    case 'review_approved':
    case 'request_changes':
      return { story: s, evidence: e, event: { type, sha: SHA_A } };
    case 'review_changes_requested':
      return { story: s, evidence: evidence({ review: { sha: SHA_A, verdict: 'CHANGES_REQUESTED', blockingFindings: 1, allAcMet: false } }), event: { type, sha: SHA_A } };
    case 'merge_completed':
      return { story: s, evidence: e, event: { type, mergedSha: SHA_B } };
    case 'candidate_head_changed':
      return { story: s, evidence: e, event: { type, newSha: SHA_B, newTree: TREE_B } };
    case 'fail':
      return { story: s, evidence: e, event: { type, reason: 'provider_down', detail: 'Provider returned 503' } };
    case 'recover':
      return { story: s, evidence: evidence({ plan: { version: 1, status: 'approved', storyRevision: 1, openClarifications: 0 } }), event: { type, target: 'READY', extraAttempts: 0, causeResolved: true } };
    case 'merge_conflict':
    case 'stop_run':
    case 'cancel':
    case 'hold':
    case 'unhold':
      return { story: s, evidence: e, event: { type } };
  }
}

const NON_TERMINAL: StoryStatus[] = ['NEW', 'READY', 'IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'BLOCKED', 'AWAITING_MERGE'];
const ACTIVE: StoryStatus[] = ['IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'];

/** Spec §16.3 — which source states each event is allowed from. */
export const ALLOWED_FROM: Record<EventType, StoryStatus[]> = {
  approve_plan: ['NEW'],
  auto_accept_plan: ['NEW'],
  edit_definition: ['NEW', 'READY', 'BLOCKED'],
  claim_implement: ['READY', 'REWORK', 'TESTING'],
  candidate_committed: ['IN_PROGRESS'],
  verification_passed: ['TESTING'],
  review_approved: ['READY_FOR_REVIEW'],
  review_changes_requested: ['READY_FOR_REVIEW'],
  merge_completed: ['AWAITING_MERGE'],
  candidate_head_changed: ['AWAITING_MERGE'],
  request_changes: ['AWAITING_MERGE'],
  merge_conflict: ['AWAITING_MERGE'],
  fail: ACTIVE,
  stop_run: ACTIVE,
  recover: ['BLOCKED'],
  cancel: NON_TERMINAL,
  hold: NON_TERMINAL,
  unhold: NON_TERMINAL,
};

export function expectedTo(type: EventType, from: StoryStatus): StoryStatus {
  switch (type) {
    case 'approve_plan': case 'auto_accept_plan': return 'READY';
    case 'edit_definition': return from === 'READY' ? 'NEW' : from;
    case 'claim_implement': return 'IN_PROGRESS';
    case 'candidate_committed': return 'TESTING';
    case 'verification_passed': return 'READY_FOR_REVIEW';
    case 'review_approved': return 'AWAITING_MERGE';
    case 'review_changes_requested': case 'request_changes': case 'merge_conflict': return 'REWORK';
    case 'merge_completed': return 'DONE';
    case 'candidate_head_changed': return 'TESTING';
    case 'fail': case 'stop_run': return 'BLOCKED';
    case 'recover': return 'READY';
    case 'cancel': return 'CANCELLED';
    case 'hold': case 'unhold': return from;
  }
}
```

```ts
// packages/workflow/test/matrix.test.ts
import { STORY_STATUS } from '@aik/contracts';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, evaluate } from '../src/index.ts';
import { ALLOWED_FROM, expectedTo, satisfying } from './fixtures.ts';

describe('transition matrix (spec §16.3)', () => {
  for (const type of EVENT_TYPES) {
    for (const status of STORY_STATUS) {
      const allowed = ALLOWED_FROM[type].includes(status);
      it(`${type} from ${status} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        const { story, evidence, event } = satisfying(type, status);
        const result = evaluate(story, evidence, event);
        if (allowed) {
          expect(result).toMatchObject({ ok: true, from: status, to: expectedTo(type, status) });
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.failedGuards[0]?.guard).toBe('state');
        }
      });
    }
  }
});
```

- [ ] **Step 4: Run the matrix test to verify it fails**

Run: `npx vitest run packages/workflow/test/matrix.test.ts`
Expected: FAIL with "Failed to load url ../src/index.ts" (no `index.ts` yet).

- [ ] **Step 5: Implement the state machine, provenance and index**

```ts
// packages/workflow/src/machine.ts
import {
  ACTIVE_STATUSES, RESUMABLE_STATUSES, STORY_STATUS, TERMINAL_STATUSES, type FailedGuard, type StoryStatus,
} from '@aik/contracts';
import type { Effect, Evidence, StoryPatch, StorySnapshot, TransitionId, TransitionResult, WorkflowEvent } from './types.ts';

type Check = readonly [ok: boolean, guard: string, reason: string];

const NON_TERMINAL: readonly StoryStatus[] = STORY_STATUS.filter((s) => !TERMINAL_STATUSES.includes(s));

function allow(s: StorySnapshot, id: TransitionId, to: StoryStatus, patch: StoryPatch = {}, effects: Effect[] = []): TransitionResult {
  const full: StoryPatch = { ...patch, status: to };
  if (to !== 'BLOCKED') {
    full.blockedReason = null;
    full.blockedFrom = null;
    full.blockedDetail = null;
  }
  return { ok: true, id, from: s.status, to, patch: full, effects };
}

function deny(checks: readonly Check[]): TransitionResult | null {
  const failedGuards: FailedGuard[] = checks.filter(([ok]) => !ok).map(([, guard, reason]) => ({ guard, reason }));
  return failedGuards.length > 0 ? { ok: false, failedGuards } : null;
}

function stateGuard(s: StorySnapshot, ev: WorkflowEvent, allowed: readonly StoryStatus[]): TransitionResult | null {
  return allowed.includes(s.status)
    ? null
    : { ok: false, failedGuards: [{ guard: 'state', reason: `${ev.type} is not allowed while the story is ${s.status}` }] };
}

const attemptsRemain = (s: StorySnapshot): Check => [
  s.attemptCount < s.maxAttempts, 'attempts', `Attempt budget exhausted (${s.attemptCount}/${s.maxAttempts})`,
];
const candidateVerified = (s: StorySnapshot, e: Evidence): Check => [
  e.verification !== null && s.candidateSha !== null && e.verification.sha === s.candidateSha && e.verification.mandatoryAllPassed,
  'verification', 'Mandatory checks have not all passed for the current candidate',
];
const candidateApproved = (s: StorySnapshot, e: Evidence): Check => [
  e.review !== null && s.candidateSha !== null && e.review.sha === s.candidateSha && e.review.verdict === 'APPROVED' &&
    e.review.blockingFindings === 0 && e.review.allAcMet,
  'review', 'There is no current approved review for the candidate',
];
const noMergeInProgress = (e: Evidence): Check => [!e.mergeInProgress, 'merge_in_progress', 'A merge is in progress'];
const interruptEffects = (s: StorySnapshot): Effect[] =>
  s.activeRunId !== null ? [{ kind: 'interrupt_active_run', runId: s.activeRunId }] : [];
const supersedeIfPlan = (e: Evidence): Effect[] =>
  e.plan !== null && e.plan.status !== 'superseded' ? [{ kind: 'supersede_plan' }] : [];

export function evaluate(s: StorySnapshot, e: Evidence, ev: WorkflowEvent): TransitionResult {
  switch (ev.type) {
    case 'approve_plan':
    case 'auto_accept_plan':
      return (
        stateGuard(s, ev, ['NEW']) ??
        deny([
          [s.title.trim().length > 0, 'title', 'The story needs a title'],
          [s.description.trim().length > 0, 'description', 'The story needs a description'],
          [s.currentAcceptanceCriteria > 0, 'acceptance_criteria', 'At least one acceptance criterion is required'],
          [s.planningStatus === 'plan_proposed', 'planning_status', `Planning status is ${s.planningStatus}, expected plan_proposed`],
          [e.plan !== null && e.plan.status === 'proposed' && e.plan.version === ev.planVersion, 'plan_version', `Plan version ${ev.planVersion} is not the proposed plan`],
          [e.plan !== null && e.plan.storyRevision === s.revision, 'plan_revision', 'The plan was made for an older story revision'],
          [e.plan !== null && e.plan.openClarifications === 0, 'clarifications', 'Clarification questions are unanswered'],
        ]) ??
        allow(s, 'T1', 'READY', { planningStatus: 'plan_approved' }, [
          { kind: 'approve_plan', planVersion: ev.planVersion, by: ev.type === 'approve_plan' ? 'human' : 'auto' },
        ])
      );

    case 'edit_definition': {
      const st = stateGuard(s, ev, ['NEW', 'READY', 'BLOCKED']);
      if (st) return st;
      const patch: StoryPatch = { revision: s.revision + 1, planningStatus: 'none' };
      return s.status === 'READY'
        ? allow(s, 'T2', 'NEW', patch, supersedeIfPlan(e))
        : allow(s, 'EDIT', s.status, patch, supersedeIfPlan(e));
    }

    case 'claim_implement': {
      const st = stateGuard(s, ev, ['READY', 'REWORK', 'TESTING']);
      if (st) return st;
      const checks: Check[] = [
        [!s.hold, 'hold', 'The story is on hold'],
        [ev.leaseHeld, 'lease', 'The worker does not hold the job lease'],
        [ev.worktreeReady, 'worktree', 'The worktree is not prepared and clean'],
        attemptsRemain(s),
        [s.activeRunId === null, 'active_run', 'Another implementation run is active'],
      ];
      if (s.status === 'READY') checks.push([e.dependenciesDone, 'dependencies', 'Not all dependencies are DONE']);
      if (s.status === 'TESTING') {
        checks.push([
          e.verification !== null && e.verification.sha === s.candidateSha && !e.verification.mandatoryAllPassed,
          'verification_failed', 'There is no failed verification of the current candidate to repair',
        ]);
      }
      const id: TransitionId = s.status === 'READY' ? 'T3' : s.status === 'REWORK' ? 'T9' : 'T6';
      return deny(checks) ?? allow(s, id, 'IN_PROGRESS', { activeRunId: ev.runId });
    }

    case 'candidate_committed':
      return (
        stateGuard(s, ev, ['IN_PROGRESS']) ??
        deny([
          [ev.runId === s.activeRunId, 'run', 'The completion is from a run that is not the active run'],
          [!ev.diffEmpty, 'diff', 'The candidate has no changes'],
          [!ev.treeAlreadyRejected, 'no_progress', 'The candidate tree is identical to a previously rejected candidate'],
        ]) ??
        allow(s, 'T4', 'TESTING', {
          candidateSha: ev.candidateSha, candidateTree: ev.candidateTree, attemptCount: s.attemptCount + 1, activeRunId: null,
        })
      );

    case 'verification_passed':
      return (
        stateGuard(s, ev, ['TESTING']) ??
        deny([[ev.sha === s.candidateSha, 'sha', 'Verification is for a different commit than the candidate'], candidateVerified(s, e)]) ??
        allow(s, 'T5', 'READY_FOR_REVIEW')
      );

    case 'review_approved':
      return (
        stateGuard(s, ev, ['READY_FOR_REVIEW']) ??
        deny([
          [ev.sha === s.candidateSha && e.review !== null && e.review.sha === s.candidateSha, 'review_sha', 'The review is not bound to the current candidate'],
          [e.review?.verdict === 'APPROVED', 'verdict', 'The review verdict is not APPROVED'],
          [(e.review?.blockingFindings ?? 1) === 0, 'blocking_findings', 'The review has blocking findings'],
          [e.review?.allAcMet === true, 'acceptance_criteria', 'Not every acceptance criterion is met'],
          candidateVerified(s, e),
        ]) ??
        allow(s, 'T7', 'AWAITING_MERGE')
      );

    case 'review_changes_requested':
      return (
        stateGuard(s, ev, ['READY_FOR_REVIEW']) ??
        deny([
          [ev.sha === s.candidateSha && e.review !== null && e.review.sha === s.candidateSha, 'review_sha', 'The review is not bound to the current candidate'],
          [e.review?.verdict === 'CHANGES_REQUESTED', 'verdict', 'The review verdict is not CHANGES_REQUESTED'],
          attemptsRemain(s),
        ]) ??
        allow(s, 'T8', 'REWORK')
      );

    case 'merge_completed':
      return (
        stateGuard(s, ev, ['AWAITING_MERGE']) ??
        deny([
          [e.mergeApprovalForCandidate, 'merge_approval', 'There is no human merge approval for the current candidate'],
          [e.merge?.succeeded === true, 'merge', 'The merge has not succeeded'],
          [e.merge !== null && e.merge.mergedSha === ev.mergedSha, 'merged_sha', 'The merged SHA does not match the recorded merge'],
          [e.merge?.containsCandidate === true, 'contains_candidate', 'The merged revision does not contain the candidate'],
          [e.postMergeVerificationPassed, 'post_merge_checks', 'Post-merge checks have not passed'],
        ]) ??
        allow(s, 'T10', 'DONE', { mergedSha: ev.mergedSha })
      );

    case 'candidate_head_changed':
      return (
        stateGuard(s, ev, ['AWAITING_MERGE']) ??
        deny([[ev.newSha !== s.candidateSha, 'sha', 'The head did not change']]) ??
        allow(s, 'T11', 'TESTING', { candidateSha: ev.newSha, candidateTree: ev.newTree })
      );

    case 'request_changes':
      return (
        stateGuard(s, ev, ['AWAITING_MERGE']) ??
        deny([
          [ev.sha === s.candidateSha, 'sha', 'Changes were requested for a commit that is not the current candidate'],
          attemptsRemain(s),
          noMergeInProgress(e),
        ]) ??
        allow(s, 'T12', 'REWORK')
      );

    case 'merge_conflict':
      return stateGuard(s, ev, ['AWAITING_MERGE']) ?? deny([attemptsRemain(s)]) ?? allow(s, 'T12', 'REWORK');

    case 'fail':
      return (
        stateGuard(s, ev, ACTIVE_STATUSES) ??
        deny([[ev.detail.trim().length > 0, 'detail', 'A blocked story needs a detail message']]) ??
        allow(
          s, 'T13', 'BLOCKED',
          { blockedReason: ev.reason, blockedFrom: s.status, blockedDetail: ev.detail.trim(), activeRunId: null },
          [...interruptEffects(s), { kind: 'cancel_jobs' }],
        )
      );

    case 'stop_run':
      return (
        stateGuard(s, ev, ACTIVE_STATUSES) ??
        deny([noMergeInProgress(e)]) ??
        allow(
          s, 'T13', 'BLOCKED',
          { blockedReason: 'interrupted', blockedFrom: s.status, blockedDetail: 'Stopped by user', activeRunId: null },
          [...interruptEffects(s), { kind: 'cancel_jobs' }],
        )
      );

    case 'recover': {
      const st = stateGuard(s, ev, ['BLOCKED']);
      if (st) return st;
      const cause: Check = [ev.causeResolved, 'cause', 'The blocking cause is not resolved yet'];
      const extra: StoryPatch = ev.extraAttempts > 0 ? { maxAttempts: s.maxAttempts + ev.extraAttempts } : {};
      if (ev.target === 'NEW') {
        return deny([cause]) ?? allow(s, 'T15', 'NEW', { planningStatus: 'none' }, supersedeIfPlan(e));
      }
      if (ev.target === 'READY') {
        return (
          deny([
            cause,
            [e.plan?.status === 'approved' && e.plan.storyRevision === s.revision, 'plan', 'There is no approved plan for the current story revision; re-plan instead'],
          ]) ?? allow(s, 'T14', 'READY', extra)
        );
      }
      const from = s.blockedFrom;
      const checks: Check[] = [
        cause,
        [from !== null && RESUMABLE_STATUSES.includes(from), 'resume_target', `Cannot resume into ${from ?? 'an unknown state'}; recover to READY or NEW`],
        [s.candidateSha !== null, 'candidate', 'There is no candidate to resume with'],
      ];
      if (from === 'READY_FOR_REVIEW') checks.push(candidateVerified(s, e));
      if (from === 'AWAITING_MERGE') checks.push(candidateVerified(s, e), candidateApproved(s, e));
      return deny(checks) ?? allow(s, 'T16', from as StoryStatus, extra);
    }

    case 'cancel':
      return (
        stateGuard(s, ev, NON_TERMINAL) ??
        deny([noMergeInProgress(e)]) ??
        allow(s, 'T17', 'CANCELLED', { hold: false, activeRunId: null }, [...interruptEffects(s), { kind: 'cancel_jobs' }])
      );

    case 'hold':
      return stateGuard(s, ev, NON_TERMINAL) ?? allow(s, 'HOLD', s.status, { hold: true });

    case 'unhold':
      return stateGuard(s, ev, NON_TERMINAL) ?? allow(s, 'UNHOLD', s.status, { hold: false });
  }
}
```

```ts
// packages/workflow/src/provenance.ts
import type { Provenance, StoryStatus } from '@aik/contracts';
import type { EventType } from './types.ts';

/** Which UI badge a transition event carries (spec §23). */
export function provenanceFor(eventType: EventType, to: StoryStatus): Provenance {
  if (to === 'DONE') return 'completion';
  switch (eventType) {
    case 'approve_plan':
    case 'request_changes':
      return 'human_approval';
    case 'verification_passed':
      return 'check_verified';
    case 'review_approved':
    case 'review_changes_requested':
      return 'review_decision';
    default:
      return 'system';
  }
}
```

```ts
// packages/workflow/src/index.ts
export * from './drag.ts';
export * from './machine.ts';
export * from './provenance.ts';
export * from './types.ts';
```

Create a placeholder-free `drag.ts` now; Step 9 adds its tests:

```ts
// packages/workflow/src/drag.ts
import { RESUMABLE_STATUSES, isTerminal, type PlanningStatus, type StoryStatus } from '@aik/contracts';

export interface DragStory {
  status: StoryStatus;
  blockedFrom: StoryStatus | null;
  planningStatus: PlanningStatus;
  activePlanVersion: number | null;
}
export interface DragTarget {
  to: StoryStatus;
  event: 'approve_plan' | 'cancel' | 'request_changes' | 'recover';
  recoverTarget?: 'READY' | 'NEW' | 'resume';
}
export type DragVerdict = { allowed: true; target: DragTarget } | { allowed: false; reason: string };

/** Maps a Kanban drop (or "Move to…") onto the one human event it may request — or explains why not. */
export function dragVerdict(story: DragStory, to: StoryStatus): DragVerdict {
  const from = story.status;
  if (from === to) return { allowed: false, reason: 'The story is already in this column' };
  if (isTerminal(from)) return { allowed: false, reason: `${from} is final` };
  if (to === 'CANCELLED') return { allowed: true, target: { to, event: 'cancel' } };
  if (from === 'NEW' && to === 'READY') {
    return story.planningStatus === 'plan_proposed' && story.activePlanVersion !== null
      ? { allowed: true, target: { to, event: 'approve_plan' } }
      : { allowed: false, reason: 'There is no proposed plan to approve yet' };
  }
  if (from === 'AWAITING_MERGE' && to === 'REWORK') return { allowed: true, target: { to, event: 'request_changes' } };
  if (from === 'BLOCKED') {
    if (to === 'READY') return { allowed: true, target: { to, event: 'recover', recoverTarget: 'READY' } };
    if (to === 'NEW') return { allowed: true, target: { to, event: 'recover', recoverTarget: 'NEW' } };
    if (to === story.blockedFrom && RESUMABLE_STATUSES.includes(to)) {
      return { allowed: true, target: { to, event: 'recover', recoverTarget: 'resume' } };
    }
    const resumable = story.blockedFrom && RESUMABLE_STATUSES.includes(story.blockedFrom) ? `, or back to ${story.blockedFrom}` : '';
    return { allowed: false, reason: `A blocked story can only be recovered to READY or NEW${resumable}` };
  }
  if (to === 'DONE') return { allowed: false, reason: 'Stories become DONE only after an approved, verified merge' };
  return { allowed: false, reason: `Only the orchestrator moves stories from ${from} to ${to}` };
}
```

- [ ] **Step 6: Run the matrix test to verify it passes**

Run: `npx vitest run packages/workflow/test/matrix.test.ts`
Expected: PASS (180 tests: 18 events × 10 states).

- [ ] **Step 7: Write the guard tests**

```ts
// packages/workflow/test/guards.test.ts
import { describe, expect, it } from 'vitest';
import { evaluate, type TransitionResult } from '../src/index.ts';
import { SHA_A, SHA_B, TREE_B, evidence, story } from './fixtures.ts';

const guards = (r: TransitionResult) => (r.ok ? [] : r.failedGuards.map((g) => g.guard));

describe('T1 approve_plan', () => {
  const ev = { type: 'approve_plan', planVersion: 1 } as const;
  it('approves and records the approval effect', () => {
    const r = evaluate(story(), evidence(), ev);
    expect(r).toMatchObject({ ok: true, id: 'T1', to: 'READY', patch: { planningStatus: 'plan_approved' } });
    if (r.ok) expect(r.effects).toEqual([{ kind: 'approve_plan', planVersion: 1, by: 'human' }]);
  });
  it('reports every unmet guard', () => {
    const r = evaluate(
      story({ description: ' ', currentAcceptanceCriteria: 0, revision: 2 }),
      evidence({ plan: { version: 1, status: 'proposed', storyRevision: 1, openClarifications: 2 } }),
      { type: 'approve_plan', planVersion: 9 },
    );
    expect(guards(r)).toEqual(['description', 'acceptance_criteria', 'plan_version', 'plan_revision', 'clarifications']);
  });
  it('auto_accept records by=auto', () => {
    const r = evaluate(story(), evidence(), { type: 'auto_accept_plan', planVersion: 1 });
    if (r.ok) expect(r.effects[0]).toEqual({ kind: 'approve_plan', planVersion: 1, by: 'auto' });
  });
});

describe('edit_definition', () => {
  it('T2 moves READY back to NEW, bumps revision and supersedes the plan', () => {
    const r = evaluate(story({ status: 'READY', revision: 3 }), evidence(), { type: 'edit_definition' });
    expect(r).toMatchObject({ ok: true, id: 'T2', to: 'NEW', patch: { revision: 4, planningStatus: 'none' }, effects: [{ kind: 'supersede_plan' }] });
  });
  it('editing a BLOCKED story keeps its blocked fields', () => {
    const r = evaluate(story({ status: 'BLOCKED', blockedReason: 'quota', blockedFrom: 'TESTING' }), evidence(), { type: 'edit_definition' });
    expect(r.ok && r.id).toBe('EDIT');
    if (r.ok) {
      expect(r.patch.status).toBe('BLOCKED');
      expect('blockedReason' in r.patch).toBe(false);
    }
  });
});

describe('claim_implement', () => {
  const ev = { type: 'claim_implement', runId: 5, leaseHeld: true, worktreeReady: true } as const;
  it('T3 from READY requires dependencies', () => {
    expect(guards(evaluate(story({ status: 'READY' }), evidence({ dependenciesDone: false }), ev))).toEqual(['dependencies']);
  });
  it('blocks when on hold, without lease, with dirty worktree, out of attempts, or with an active run', () => {
    const r = evaluate(story({ status: 'REWORK', hold: true, attemptCount: 3, activeRunId: 2 }), evidence(), { ...ev, leaseHeld: false, worktreeReady: false });
    expect(guards(r)).toEqual(['hold', 'lease', 'worktree', 'attempts', 'active_run']);
  });
  it('T6 from TESTING requires a failed verification of the candidate', () => {
    expect(guards(evaluate(story({ status: 'TESTING' }), evidence(), ev))).toEqual(['verification_failed']);
  });
  it('sets the active run', () => {
    expect(evaluate(story({ status: 'REWORK' }), evidence(), ev)).toMatchObject({ ok: true, id: 'T9', patch: { activeRunId: 5 } });
  });
});

describe('T4 candidate_committed', () => {
  const base = { type: 'candidate_committed', runId: 7, candidateSha: SHA_B, candidateTree: TREE_B, diffEmpty: false, treeAlreadyRejected: false } as const;
  it('rejects stale runs, empty diffs and repeated trees', () => {
    const r = evaluate(story({ status: 'IN_PROGRESS', activeRunId: 8 }), evidence(), { ...base, diffEmpty: true, treeAlreadyRejected: true });
    expect(guards(r)).toEqual(['run', 'diff', 'no_progress']);
  });
  it('records the candidate and consumes one attempt', () => {
    const r = evaluate(story({ status: 'IN_PROGRESS', activeRunId: 7, attemptCount: 1 }), evidence(), base);
    expect(r).toMatchObject({ ok: true, to: 'TESTING', patch: { candidateSha: SHA_B, candidateTree: TREE_B, attemptCount: 2, activeRunId: null } });
  });
});

describe('T5 verification_passed', () => {
  it('rejects verification of another commit or with failed mandatory checks', () => {
    expect(guards(evaluate(story({ status: 'TESTING' }), evidence(), { type: 'verification_passed', sha: SHA_B }))).toEqual(['sha']);
    expect(guards(evaluate(story({ status: 'TESTING' }), evidence({ verification: { sha: SHA_A, mandatoryAllPassed: false } }), { type: 'verification_passed', sha: SHA_A }))).toEqual(['verification']);
  });
});

describe('T7 review_approved', () => {
  it('rejects a review bound to an older candidate (stale approval)', () => {
    const r = evaluate(story({ status: 'READY_FOR_REVIEW', candidateSha: SHA_B }), evidence(), { type: 'review_approved', sha: SHA_B });
    expect(guards(r)).toContain('review_sha');
  });
  it('rejects blocking findings and unmet criteria', () => {
    const r = evaluate(story({ status: 'READY_FOR_REVIEW' }), evidence({ review: { sha: SHA_A, verdict: 'APPROVED', blockingFindings: 1, allAcMet: false } }), { type: 'review_approved', sha: SHA_A });
    expect(guards(r)).toEqual(['blocking_findings', 'acceptance_criteria']);
  });
});

describe('T8 review_changes_requested', () => {
  it('needs attempts left', () => {
    const r = evaluate(story({ status: 'READY_FOR_REVIEW', attemptCount: 3 }), evidence({ review: { sha: SHA_A, verdict: 'CHANGES_REQUESTED', blockingFindings: 1, allAcMet: false } }), { type: 'review_changes_requested', sha: SHA_A });
    expect(guards(r)).toEqual(['attempts']);
  });
});

describe('T10 merge_completed', () => {
  it('requires human approval and passing post-merge checks', () => {
    const r = evaluate(story({ status: 'AWAITING_MERGE' }), evidence({ mergeApprovalForCandidate: false, postMergeVerificationPassed: false }), { type: 'merge_completed', mergedSha: SHA_B });
    expect(guards(r)).toEqual(['merge_approval', 'post_merge_checks']);
  });
});

describe('T13 fail / stop_run', () => {
  it('requires a detail and remembers where it came from', () => {
    expect(guards(evaluate(story({ status: 'TESTING' }), evidence(), { type: 'fail', reason: 'quota', detail: '  ' }))).toEqual(['detail']);
    const r = evaluate(story({ status: 'IN_PROGRESS', activeRunId: 4 }), evidence(), { type: 'fail', reason: 'quota', detail: 'quota exhausted' });
    expect(r).toMatchObject({ ok: true, patch: { blockedReason: 'quota', blockedFrom: 'IN_PROGRESS', blockedDetail: 'quota exhausted', activeRunId: null } });
    if (r.ok) expect(r.effects).toEqual([{ kind: 'interrupt_active_run', runId: 4 }, { kind: 'cancel_jobs' }]);
  });
  it('stop_run is refused while merging', () => {
    expect(guards(evaluate(story({ status: 'AWAITING_MERGE' }), evidence({ mergeInProgress: true }), { type: 'stop_run' }))).toEqual(['merge_in_progress']);
  });
});

describe('recover (T14–T16)', () => {
  const blocked = story({ status: 'BLOCKED', blockedReason: 'quota', blockedFrom: 'READY_FOR_REVIEW' });
  it('T14 to READY needs an approved plan for this revision and can add attempts', () => {
    expect(guards(evaluate(blocked, evidence(), { type: 'recover', target: 'READY', extraAttempts: 0, causeResolved: true }))).toEqual(['plan']);
    const r = evaluate(blocked, evidence({ plan: { version: 1, status: 'approved', storyRevision: 1, openClarifications: 0 } }), { type: 'recover', target: 'READY', extraAttempts: 2, causeResolved: true });
    expect(r).toMatchObject({ ok: true, id: 'T14', patch: { maxAttempts: 5, blockedReason: null, blockedFrom: null, blockedDetail: null } });
  });
  it('T16 resumes into the blocked step only with current evidence', () => {
    expect(evaluate(blocked, evidence(), { type: 'recover', target: 'resume', extraAttempts: 0, causeResolved: true })).toMatchObject({ ok: true, id: 'T16', to: 'READY_FOR_REVIEW' });
    const fromInProgress = story({ status: 'BLOCKED', blockedReason: 'interrupted', blockedFrom: 'IN_PROGRESS' });
    expect(guards(evaluate(fromInProgress, evidence(), { type: 'recover', target: 'resume', extraAttempts: 0, causeResolved: true }))).toEqual(['resume_target']);
    const fromMerge = story({ status: 'BLOCKED', blockedReason: 'auth', blockedFrom: 'AWAITING_MERGE' });
    expect(guards(evaluate(fromMerge, evidence({ review: null }), { type: 'recover', target: 'resume', extraAttempts: 0, causeResolved: true }))).toEqual(['review']);
  });
  it('refuses while the cause is unresolved', () => {
    expect(guards(evaluate(blocked, evidence(), { type: 'recover', target: 'NEW', extraAttempts: 0, causeResolved: false }))).toEqual(['cause']);
  });
});

describe('T17 cancel', () => {
  it('is refused during a merge and kills active work otherwise', () => {
    expect(guards(evaluate(story({ status: 'AWAITING_MERGE' }), evidence({ mergeInProgress: true }), { type: 'cancel' }))).toEqual(['merge_in_progress']);
    const r = evaluate(story({ status: 'IN_PROGRESS', activeRunId: 3, hold: true }), evidence(), { type: 'cancel' });
    expect(r).toMatchObject({ ok: true, to: 'CANCELLED', patch: { hold: false, activeRunId: null } });
  });
});
```

- [ ] **Step 8: Write the property test**

```ts
// packages/workflow/test/properties.test.ts
import { BLOCKED_REASON, PLANNING_STATUS, PLAN_STATUS, STORY_STATUS, VERDICT, isTerminal } from '@aik/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, type Evidence, type StorySnapshot, type WorkflowEvent } from '../src/index.ts';
import { SHA_A, SHA_B, TREE_A, TREE_B } from './fixtures.ts';

const statusArb = fc.constantFrom(...STORY_STATUS);
const shaArb = fc.constantFrom(SHA_A, SHA_B);

const storyArb: fc.Arbitrary<StorySnapshot> = fc
  .record({
    status: statusArb,
    planningStatus: fc.constantFrom(...PLANNING_STATUS),
    hold: fc.boolean(),
    revision: fc.integer({ min: 1, max: 3 }),
    attemptCount: fc.integer({ min: 0, max: 4 }),
    maxAttempts: fc.integer({ min: 1, max: 4 }),
    candidateSha: fc.option(shaArb, { nil: null }),
    candidateTree: fc.option(fc.constantFrom(TREE_A, TREE_B), { nil: null }),
    blockedFrom: fc.option(statusArb, { nil: null }),
    blockedReason: fc.option(fc.constantFrom(...BLOCKED_REASON), { nil: null }),
    activeRunId: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
    title: fc.constantFrom('', 'title'),
    description: fc.constantFrom('', 'description'),
    currentAcceptanceCriteria: fc.integer({ min: 0, max: 2 }),
  })
  // Only consistent inputs: the DB CHECK constraint guarantees BLOCKED ⇔ blockedReason.
  .filter((s) => (s.status === 'BLOCKED') === (s.blockedReason !== null));

const evidenceArb: fc.Arbitrary<Evidence> = fc.record({
  plan: fc.option(fc.record({ version: fc.integer({ min: 1, max: 2 }), status: fc.constantFrom(...PLAN_STATUS), storyRevision: fc.integer({ min: 1, max: 3 }), openClarifications: fc.integer({ min: 0, max: 1 }) }), { nil: null }),
  dependenciesDone: fc.boolean(),
  mergeInProgress: fc.boolean(),
  verification: fc.option(fc.record({ sha: shaArb, mandatoryAllPassed: fc.boolean() }), { nil: null }),
  review: fc.option(fc.record({ sha: shaArb, verdict: fc.constantFrom(...VERDICT), blockingFindings: fc.integer({ min: 0, max: 1 }), allAcMet: fc.boolean() }), { nil: null }),
  mergeApprovalForCandidate: fc.boolean(),
  merge: fc.option(fc.record({ succeeded: fc.boolean(), mergedSha: fc.option(shaArb, { nil: null }), containsCandidate: fc.boolean() }), { nil: null }),
  postMergeVerificationPassed: fc.boolean(),
});

const eventArb: fc.Arbitrary<WorkflowEvent> = fc.oneof(
  fc.record({ type: fc.constantFrom('approve_plan' as const, 'auto_accept_plan' as const), planVersion: fc.integer({ min: 1, max: 2 }) }),
  fc.constant({ type: 'edit_definition' as const }),
  fc.record({ type: fc.constant('claim_implement' as const), runId: fc.integer({ min: 1, max: 3 }), leaseHeld: fc.boolean(), worktreeReady: fc.boolean() }),
  fc.record({ type: fc.constant('candidate_committed' as const), runId: fc.integer({ min: 1, max: 3 }), candidateSha: shaArb, candidateTree: fc.constantFrom(TREE_A, TREE_B), diffEmpty: fc.boolean(), treeAlreadyRejected: fc.boolean() }),
  fc.record({ type: fc.constantFrom('verification_passed' as const, 'review_approved' as const, 'review_changes_requested' as const, 'request_changes' as const), sha: shaArb }),
  fc.record({ type: fc.constant('merge_completed' as const), mergedSha: shaArb }),
  fc.record({ type: fc.constant('candidate_head_changed' as const), newSha: shaArb, newTree: fc.constantFrom(TREE_A, TREE_B) }),
  fc.record({ type: fc.constant('fail' as const), reason: fc.constantFrom(...BLOCKED_REASON), detail: fc.constantFrom('', 'detail') }),
  fc.record({ type: fc.constant('recover' as const), target: fc.constantFrom('READY' as const, 'NEW' as const, 'resume' as const), extraAttempts: fc.integer({ min: 0, max: 2 }), causeResolved: fc.boolean() }),
  fc.constantFrom({ type: 'merge_conflict' as const }, { type: 'stop_run' as const }, { type: 'cancel' as const }, { type: 'hold' as const }, { type: 'unhold' as const }),
).map((e) => e as WorkflowEvent);

describe('state machine invariants (spec §16.6)', () => {
  it('holds I1–I5 for arbitrary inputs', () => {
    fc.assert(
      fc.property(storyArb, evidenceArb, eventArb, (s, e, ev) => {
        const r = evaluate(s, e, ev);
        if (isTerminal(s.status)) expect(r.ok).toBe(false); // terminal states have no exits
        if (!r.ok) return;
        const after = { ...s, ...r.patch };
        expect(STORY_STATUS).toContain(after.status);
        // I5: BLOCKED ⇔ blockedReason
        expect(after.status === 'BLOCKED').toBe(after.blockedReason !== null);
        // I1: DONE requires approval + successful merge containing the candidate + post-merge checks
        if (r.to === 'DONE') {
          expect(e.mergeApprovalForCandidate && e.merge?.succeeded && e.merge.containsCandidate && e.postMergeVerificationPassed).toBe(true);
        }
        // I2: entering AWAITING_MERGE requires a current approved review and verification
        if (r.to === 'AWAITING_MERGE' && r.from !== 'AWAITING_MERGE') {
          expect(e.review?.verdict).toBe('APPROVED');
          expect(e.review?.sha).toBe(after.candidateSha);
          expect(e.verification?.sha === after.candidateSha && e.verification.mandatoryAllPassed).toBe(true);
        }
        // I3: entering READY_FOR_REVIEW requires passed verification of the candidate
        if (r.to === 'READY_FOR_REVIEW' && r.from !== 'READY_FOR_REVIEW') {
          expect(e.verification?.sha === after.candidateSha && e.verification.mandatoryAllPassed).toBe(true);
        }
        // Implementation only starts within budget and not on hold
        if (r.to === 'IN_PROGRESS' && r.from !== 'IN_PROGRESS') {
          expect(s.attemptCount < s.maxAttempts && !s.hold).toBe(true);
        }
      }),
      { numRuns: 5000 },
    );
  });
});
```

- [ ] **Step 9: Write the drag tests**

```ts
// packages/workflow/test/drag.test.ts
import { describe, expect, it } from 'vitest';
import { dragVerdict, type DragStory } from '../src/index.ts';

const s = (o: Partial<DragStory>): DragStory => ({ status: 'NEW', blockedFrom: null, planningStatus: 'none', activePlanVersion: null, ...o });

describe('dragVerdict', () => {
  it('allows cancel from any non-terminal state', () => {
    expect(dragVerdict(s({ status: 'IN_PROGRESS' }), 'CANCELLED')).toEqual({ allowed: true, target: { to: 'CANCELLED', event: 'cancel' } });
  });
  it('refuses to drag into DONE with a clear reason', () => {
    expect(dragVerdict(s({}), 'DONE')).toEqual({ allowed: false, reason: 'Stories become DONE only after an approved, verified merge' });
  });
  it('NEW → READY only when a plan is proposed', () => {
    expect(dragVerdict(s({}), 'READY').allowed).toBe(false);
    expect(dragVerdict(s({ planningStatus: 'plan_proposed', activePlanVersion: 2 }), 'READY')).toEqual({ allowed: true, target: { to: 'READY', event: 'approve_plan' } });
  });
  it('BLOCKED recovers to READY, NEW or its resumable source', () => {
    const b = s({ status: 'BLOCKED', blockedFrom: 'TESTING' });
    expect(dragVerdict(b, 'TESTING')).toEqual({ allowed: true, target: { to: 'TESTING', event: 'recover', recoverTarget: 'resume' } });
    expect(dragVerdict(b, 'IN_PROGRESS')).toEqual({ allowed: false, reason: 'A blocked story can only be recovered to READY or NEW, or back to TESTING' });
  });
  it('system-only moves explain who moves them', () => {
    expect(dragVerdict(s({ status: 'READY' }), 'IN_PROGRESS')).toEqual({ allowed: false, reason: 'Only the orchestrator moves stories from READY to IN_PROGRESS' });
  });
  it('terminal stories never move', () => {
    expect(dragVerdict(s({ status: 'DONE' }), 'CANCELLED')).toEqual({ allowed: false, reason: 'DONE is final' });
  });
});
```

- [ ] **Step 10: Run all workflow tests and static checks**

Run: `npx vitest run packages/workflow && npm run lint && npm run typecheck`
Expected: PASS (matrix, guards, properties with 5,000 runs, drag); no lint or type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/workflow package.json package-lock.json
git commit -m "feat(workflow): pure story state machine with exhaustive matrix, guard and property tests"
```


---

### Task 4: SQLite schema, migrations, backups (FND-5)

**Files:**
- Create: `packages/db/package.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `json-types.ts`, `backup.ts`, `open.ts`, `index.ts`
- Generate: `packages/db/migrations/0000_init.sql`, `packages/db/migrations/meta/**`
- Create (custom migration): `packages/db/migrations/0001_immutability_triggers.sql`
- Test: `packages/db/test/open.test.ts`, `packages/db/test/constraints.test.ts`

**Interfaces:**
- Consumes: enums and the `ProjectSettings`/`PlanV1`/`ReviewV1` types from `@aik/contracts`.
- Produces from `@aik/db`:
  - **Tables:** all 28, named exactly as spec §15.2 in camelCase, e.g. `userStories`, `storyEvents`, `outboxEvents`, `durableJobs`, `apiIdempotency`.
  - **Constants:** `JOB_KINDS`, `JOB_SLOTS`, `JOB_STATUSES`, `IMMUTABLE_TABLES`.
  - **Types:** `AikDb` (better-sqlite3 Drizzle database with `$client`), `AikTx`, and `AikDbOrTx` (a base type accepted by query helpers that run in or out of a transaction).
  - **Database lifecycle:** `openDatabase({ file, backupsDir, migrationsFolder, keepBackups?, now? }): { db, sqlite, backupFile, close() }` and `DatabaseCorruptError`.
- Produces from `@aik/db/backup` (pure `fs`, safe to import in the Electron main process):
  - `backupFileName(d)`, `listBackups(dir)`, `pruneBackups(dir, keep)`;
  - `restoreBackup(backupFile, targetFile): { movedAside: string | null }`.

- [ ] **Step 1: Create the package and install dependencies**

```json
// packages/db/package.json
{
  "name": "@aik/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./backup": "./src/backup.ts" },
  "dependencies": {
    "@aik/contracts": "0.0.0",
    "better-sqlite3": "13.0.3",
    "drizzle-orm": "0.45.4"
  }
}
```

Run: `npm install -E -D drizzle-kit@0.31.11 @types/better-sqlite3@9.6.0`, then `npm install`
Expected: install succeeds without compiling. better-sqlite3 13 ships an N-API prebuild for win32-x64.

Add the root script (edit `package.json` `scripts`):

```json
"db:generate": "drizzle-kit generate --config packages/db/drizzle.config.ts"
```

```ts
// packages/db/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/migrations',
});
```

- [ ] **Step 2: Write the JSON column types and the schema**

```ts
// packages/db/src/json-types.ts
export interface ChecksSummary { total: number; passed: number; failed: number; pending: number; conclusion: 'success' | 'failure' | 'pending' | 'none' }
export interface ReviewsSummary { approved: number; changesRequested: number; commented: number }
export interface QuotaState { exhaustedUntil: number | null; lastStatus: number | null; remaining: number | null }
export interface ProbeResult { toolCall: boolean; longContext: boolean; jsonSchema: boolean; ttftMs: number | null; genTokensPerSec: number | null; testedAt: number }
export interface StoryEventPayload { [key: string]: unknown }
export interface OutboxPayload { provenance: string; data: unknown }
```

```ts
// packages/db/src/schema.ts
import {
  BLOCKED_REASON, PLANNING_STATUS, PRIORITY, ROLE, STORY_STATUS,
  type PlanV1, type ProjectSettings, type ReviewV1,
} from '@aik/contracts';
import { sql } from 'drizzle-orm';
import {
  check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type { ChecksSummary, OutboxPayload, ProbeResult, QuotaState, ReviewsSummary, StoryEventPayload } from './json-types.ts';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const shaOk = (col: string) => `(${col} IS NULL OR length(${col}) IN (40, 64))`;

export const JOB_KINDS = ['plan', 'implement', 'verify', 'review', 'publish', 'merge', 'postmerge', 'pr_poll', 'fetch', 'clone', 'cleanup', 'retention'] as const;
export const JOB_SLOTS = ['heavy', 'light'] as const;
export const JOB_STATUSES = ['queued', 'leased', 'succeeded', 'failed', 'dead', 'cancelled'] as const;

// ───────────── Projects & GitHub ─────────────
export const githubConnections = sqliteTable('github_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubUserId: integer('github_user_id').notNull(),
  login: text('login').notNull(),
  appClientId: text('app_client_id').notNull(),
  tokenRef: text('token_ref').notNull(),
  accessExpiresAt: ts('access_expires_at'),
  refreshExpiresAt: ts('refresh_expires_at'),
  status: text('status', { enum: ['connected', 'expired', 'revoked', 'disconnected', 'error'] }).notNull(),
  grantedPermissions: text('granted_permissions', { mode: 'json' }).$type<Record<string, string>>(),
  lastValidatedAt: ts('last_validated_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [uniqueIndex('gh_conn_user_uq').on(t.githubUserId)]);

export const repositoryConnections = sqliteTable('repository_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubConnectionId: integer('github_connection_id').notNull().references(() => githubConnections.id, { onDelete: 'cascade' }),
  githubRepoId: integer('github_repo_id').notNull(),
  installationId: integer('installation_id'),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  defaultBranch: text('default_branch').notNull(),
  visibility: text('visibility', { enum: ['public', 'private', 'internal'] }).notNull(),
  permissions: text('permissions', { mode: 'json' }).$type<{ admin: boolean; push: boolean; pull: boolean }>(),
  localPath: text('local_path'),
  etag: text('etag'),
  lastSyncedAt: ts('last_synced_at'),
}, (t) => [
  uniqueIndex('repo_conn_uq').on(t.githubConnectionId, t.githubRepoId),
  index('repo_conn_name_idx').on(t.owner, t.name),
]);

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull(),
  baseBranch: text('base_branch').notNull(),
  remoteUrl: text('remote_url'),
  repositoryConnectionId: integer('repository_connection_id').references(() => repositoryConnections.id, { onDelete: 'set null' }),
  settings: text('settings', { mode: 'json' }).$type<ProjectSettings>().notNull(),
  nextStoryNumber: integer('next_story_number').notNull().default(1),
  status: text('status', { enum: ['active', 'unavailable', 'archived'] }).notNull().default('active'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [uniqueIndex('projects_key_uq').on(t.key), uniqueIndex('projects_repo_uq').on(t.repoPath)]);

// ───────────── Stories ─────────────
export const userStories = sqliteTable('user_stories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  key: text('key').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  priority: text('priority', { enum: PRIORITY }).notNull().default('P2'),
  rank: integer('rank').notNull(),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  complexity: text('complexity', { enum: ['S', 'M', 'L', 'XL'] }),
  revision: integer('revision').notNull().default(1),
  status: text('status', { enum: STORY_STATUS }).notNull().default('NEW'),
  statusVersion: integer('status_version').notNull().default(0),
  planningStatus: text('planning_status', { enum: PLANNING_STATUS }).notNull().default('none'),
  activePlanId: integer('active_plan_id').references((): AnySQLiteColumn => plans.id),
  hold: integer('hold', { mode: 'boolean' }).notNull().default(false),
  blockedReason: text('blocked_reason', { enum: BLOCKED_REASON }),
  blockedFrom: text('blocked_from', { enum: STORY_STATUS }),
  blockedDetail: text('blocked_detail'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  activeRunId: integer('active_run_id').references((): AnySQLiteColumn => agentRuns.id),
  branchName: text('branch_name'),
  baseSha: text('base_sha'),
  candidateSha: text('candidate_sha'),
  candidateTree: text('candidate_tree'),
  mergedSha: text('merged_sha'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  doneAt: ts('done_at'),
  cancelledAt: ts('cancelled_at'),
}, (t) => [
  uniqueIndex('story_key_uq').on(t.projectId, t.key),
  index('story_board_idx').on(t.projectId, t.status, t.rank),
  check('story_sha_ck', sql.raw(`${shaOk('base_sha')} AND ${shaOk('candidate_sha')} AND ${shaOk('candidate_tree')} AND ${shaOk('merged_sha')}`)),
  check('story_blocked_ck', sql.raw(`(status = 'BLOCKED') = (blocked_reason IS NOT NULL)`)),
]);

export const storyDependencies = sqliteTable('story_dependencies', {
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  dependsOnStoryId: integer('depends_on_story_id').notNull().references(() => userStories.id),
}, (t) => [
  primaryKey({ columns: [t.storyId, t.dependsOnStoryId] }),
  check('dep_self_ck', sql.raw('story_id <> depends_on_story_id')),
]);

export const acceptanceCriteria = sqliteTable('acceptance_criteria', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  storyRevision: integer('story_revision').notNull(),
  ordinal: integer('ordinal').notNull(),
  text: text('text').notNull(),
  source: text('source', { enum: ['human', 'planner'] }).notNull(),
  supersededAt: ts('superseded_at'),
  createdAt: ts('created_at').notNull(),
}, (t) => [uniqueIndex('ac_uq').on(t.storyId, t.storyRevision, t.ordinal)]);

export const plans = sqliteTable('plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  storyRevision: integer('story_revision').notNull(),
  agentRunId: integer('agent_run_id').references((): AnySQLiteColumn => agentRuns.id),
  content: text('content', { mode: 'json' }).$type<PlanV1>().notNull(),
  status: text('status', { enum: ['proposed', 'approved', 'rejected', 'superseded'] }).notNull(),
  approvedBy: text('approved_by', { enum: ['human', 'auto'] }),
  approvedAt: ts('approved_at'),
  rejectionFeedback: text('rejection_feedback'),
  createdAt: ts('created_at').notNull(),
}, (t) => [uniqueIndex('plan_ver_uq').on(t.storyId, t.version)]);

export const clarifications = sqliteTable('clarifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  question: text('question').notNull(),
  answer: text('answer'),
  answeredAt: ts('answered_at'),
}, (t) => [uniqueIndex('clar_uq').on(t.planId, t.ordinal)]);

// ───────────── Execution ─────────────
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  kind: text('kind', { enum: ['story', 'review', 'verify', 'postmerge'] }).notNull(),
  path: text('path').notNull(),
  branch: text('branch'),
  headSha: text('head_sha'),
  status: text('status', { enum: ['active', 'preserved', 'removed'] }).notNull(),
  createdAt: ts('created_at').notNull(),
  removedAt: ts('removed_at'),
}, (t) => [
  uniqueIndex('ws_path_active_uq').on(t.path).where(sql.raw(`status <> 'removed'`)),
  check('ws_sha_ck', sql.raw(shaOk('head_sha'))),
]);

export const modelProfiles = sqliteTable('model_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: integer('provider_id').notNull().references((): AnySQLiteColumn => providers.id),
  modelId: text('model_id').notNull(),
  family: text('family'),
  contextLimit: integer('context_limit').notNull(),
  outputLimit: integer('output_limit').notNull(),
  probe: text('probe', { mode: 'json' }).$type<ProbeResult>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
}, (t) => [uniqueIndex('mp_uq').on(t.providerId, t.modelId)]);

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  role: text('role', { enum: ROLE }).notNull(),
  attempt: integer('attempt').notNull(),
  modelProfileId: integer('model_profile_id').references(() => modelProfiles.id),
  promptVersion: text('prompt_version').notNull(),
  opencodeVersion: text('opencode_version').notNull(),
  opencodeSessionId: text('opencode_session_id'),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  inputSha: text('input_sha'),
  resultSha: text('result_sha'),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'timed_out', 'cancelled'] }).notNull(),
  failureClass: text('failure_class', { enum: ['agent', 'infrastructure'] }),
  exitReason: text('exit_reason'),
  usage: text('usage', { mode: 'json' }).$type<{ requests: number; inTok: number; outTok: number }>(),
  logPath: text('log_path'),
  idempotencyKey: text('idempotency_key').notNull(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
}, (t) => [
  uniqueIndex('run_idem_uq').on(t.idempotencyKey),
  index('run_story_idx').on(t.storyId, t.role, t.attempt),
  check('run_sha_ck', sql.raw(`${shaOk('input_sha')} AND ${shaOk('result_sha')}`)),
]);

export const verificationRuns = sqliteTable('verification_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  commitSha: text('commit_sha').notNull(),
  trigger: text('trigger', { enum: ['candidate', 'postmerge', 'cleanroom'] }).notNull(),
  status: text('status', { enum: ['running', 'passed', 'failed', 'error'] }).notNull(),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [
  index('vr_story_sha_idx').on(t.storyId, t.commitSha),
  check('vr_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const verificationChecks = sqliteTable('verification_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  verificationRunId: integer('verification_run_id').notNull().references(() => verificationRuns.id),
  checkKey: text('check_key').notNull(),
  mandatory: integer('mandatory', { mode: 'boolean' }).notNull(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status', { enum: ['passed', 'failed', 'error', 'timed_out', 'skipped', 'unsupported'] }).notNull(),
  exitCode: integer('exit_code'),
  outputTail: text('output_tail'),
  logPath: text('log_path'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at').notNull(),
}, (t) => [uniqueIndex('vc_uq').on(t.verificationRunId, t.checkKey)]);

export const reviews = sqliteTable('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  commitSha: text('commit_sha').notNull(),
  actor: text('actor', { enum: ['agent', 'human'] }).notNull(),
  agentRunId: integer('agent_run_id').references(() => agentRuns.id),
  rawVerdict: text('raw_verdict', { enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] }).notNull(),
  verdict: text('verdict', { enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] }).notNull(),
  normalizationNote: text('normalization_note'),
  summary: text('summary').notNull(),
  raw: text('raw', { mode: 'json' }).$type<ReviewV1>().notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('review_story_sha_idx').on(t.storyId, t.commitSha),
  check('review_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const reviewFindings = sqliteTable('review_findings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reviewId: integer('review_id').notNull().references(() => reviews.id),
  findingKey: text('finding_key').notNull(),
  severity: text('severity', { enum: ['critical', 'high', 'medium', 'low', 'info'] }).notNull(),
  category: text('category').notNull(),
  filePath: text('file_path'),
  lineStart: integer('line_start'),
  lineEnd: integer('line_end'),
  evidence: text('evidence').notNull(),
  explanation: text('explanation').notNull(),
  recommendation: text('recommendation').notNull(),
  blocking: integer('blocking', { mode: 'boolean' }).notNull(),
  priorFindingId: integer('prior_finding_id').references((): AnySQLiteColumn => reviewFindings.id),
  resolution: text('resolution', { enum: ['resolved', 'unresolved', 'disputed'] }),
}, (t) => [uniqueIndex('rf_uq').on(t.reviewId, t.findingKey)]);

export const reviewAcResults = sqliteTable('review_ac_results', {
  reviewId: integer('review_id').notNull().references(() => reviews.id),
  acceptanceCriterionId: integer('acceptance_criterion_id').notNull().references(() => acceptanceCriteria.id),
  status: text('status', { enum: ['met', 'unmet', 'unclear'] }).notNull(),
  evidence: text('evidence').notNull(),
}, (t) => [primaryKey({ columns: [t.reviewId, t.acceptanceCriterionId] })]);

// ───────────── Approvals, merges, PRs ─────────────
export const mergeApprovals = sqliteTable('merge_approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  kind: text('kind', { enum: ['publish', 'merge', 'override_remote_review'] }).notNull(),
  commitSha: text('commit_sha').notNull(),
  approver: text('approver').notNull().default('local-user'),
  note: text('note'),
  approvedAt: ts('approved_at').notNull(),
}, (t) => [
  uniqueIndex('ma_uq').on(t.storyId, t.kind, t.commitSha),
  check('ma_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const pullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  repositoryConnectionId: integer('repository_connection_id').notNull().references(() => repositoryConnections.id),
  number: integer('number').notNull(),
  url: text('url').notNull(),
  headBranch: text('head_branch').notNull(),
  headSha: text('head_sha').notNull(),
  baseBranch: text('base_branch').notNull(),
  state: text('state', { enum: ['open', 'closed', 'merged'] }).notNull(),
  mergeable: integer('mergeable', { mode: 'boolean' }),
  checksSummary: text('checks_summary', { mode: 'json' }).$type<ChecksSummary>(),
  reviewsSummary: text('reviews_summary', { mode: 'json' }).$type<ReviewsSummary>(),
  mergeCommitSha: text('merge_commit_sha'),
  etag: text('etag'),
  lastPolledAt: ts('last_polled_at'),
}, (t) => [
  uniqueIndex('pr_uq').on(t.repositoryConnectionId, t.number),
  index('pr_story_idx').on(t.storyId),
  check('pr_sha_ck', sql.raw(`${shaOk('head_sha')} AND ${shaOk('merge_commit_sha')}`)),
]);

export const merges = sqliteTable('merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  method: text('method', { enum: ['local_merge', 'local_squash', 'github_merge', 'github_squash', 'github_external'] }).notNull(),
  approvedSha: text('approved_sha').notNull(),
  baseBefore: text('base_before'),
  baseAfter: text('base_after'),
  mergedSha: text('merged_sha'),
  pullRequestId: integer('pull_request_id').references(() => pullRequests.id),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  error: text('error'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [check('merge_sha_ck', sql.raw(`${shaOk('approved_sha')} AND ${shaOk('base_before')} AND ${shaOk('base_after')} AND ${shaOk('merged_sha')}`))]);

export const remoteSyncRuns = sqliteTable('remote_sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['clone', 'fetch', 'push', 'pr_create', 'pr_poll', 'merge'] }).notNull(),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  shaBefore: text('sha_before'),
  shaAfter: text('sha_after'),
  detail: text('detail'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [index('rsr_project_idx').on(t.projectId, t.startedAt)]);

// ───────────── Models ─────────────
export const providers = sqliteTable('providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  presetKey: text('preset_key'),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['ollama', 'openai_compatible'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  keyRef: text('key_ref'),
  costClass: text('cost_class', { enum: ['local', 'free', 'free_limited', 'paid_flat', 'paid_metered'] }).notNull(),
  dataUse: text('data_use', { enum: ['no_training', 'may_train', 'unknown'] }).notNull(),
  termsUrl: text('terms_url'),
  termsCheckedAt: ts('terms_checked_at'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  quotaState: text('quota_state', { mode: 'json' }).$type<QuotaState>(),
});

export const roleRoutes = sqliteTable('role_routes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').references(() => projects.id),
  role: text('role', { enum: ROLE }).notNull(),
  position: integer('position').notNull(),
  modelProfileId: integer('model_profile_id').notNull().references(() => modelProfiles.id),
}, (t) => [uniqueIndex('rr_uq').on(t.projectId, t.role, t.position)]);

export const modelUsage = sqliteTable('model_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentRunId: integer('agent_run_id').references(() => agentRuns.id),
  modelProfileId: integer('model_profile_id').notNull().references(() => modelProfiles.id),
  httpStatus: integer('http_status').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms').notNull(),
  fallbackFrom: integer('fallback_from').references(() => modelProfiles.id),
  createdAt: ts('created_at').notNull(),
}, (t) => [index('mu_profile_time_idx').on(t.modelProfileId, t.createdAt)]);

// ───────────── System ─────────────
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const storyEvents = sqliteTable('story_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  type: text('type').notNull(),
  fromStatus: text('from_status', { enum: STORY_STATUS }),
  toStatus: text('to_status', { enum: STORY_STATUS }),
  actor: text('actor').notNull(),
  payload: text('payload', { mode: 'json' }).$type<StoryEventPayload>(),
  idempotencyKey: text('idempotency_key'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('se_story_idx').on(t.storyId, t.id),
  uniqueIndex('se_idem_uq').on(t.idempotencyKey).where(sql.raw('idempotency_key IS NOT NULL')),
]);

export const outboxEvents = sqliteTable('outbox_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  topic: text('topic').notNull(),
  storyId: integer('story_id'),
  payload: text('payload', { mode: 'json' }).$type<OutboxPayload>().notNull(),
  createdAt: ts('created_at').notNull(),
});

export const durableJobs = sqliteTable('durable_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: JOB_KINDS }).notNull(),
  slot: text('slot', { enum: JOB_SLOTS }).notNull(),
  storyId: integer('story_id').references(() => userStories.id),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  sideEffecting: integer('side_effecting', { mode: 'boolean' }).notNull(),
  status: text('status', { enum: JOB_STATUSES }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAfter: ts('run_after').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: ts('lease_expires_at'),
  heartbeatAt: ts('heartbeat_at'),
  idempotencyKey: text('idempotency_key').notNull(),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  uniqueIndex('job_idem_uq').on(t.idempotencyKey),
  index('job_claim_idx').on(t.status, t.slot, t.runAfter),
]);

export const apiIdempotency = sqliteTable('api_idempotency', {
  key: text('key').primaryKey(),
  route: text('route').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: text('response_body', { mode: 'json' }),
  createdAt: ts('created_at').notNull(),
});

/** Audit tables made append-only by triggers in migration 0001. */
export const IMMUTABLE_TABLES = [
  'story_events', 'reviews', 'review_findings', 'review_ac_results', 'verification_checks', 'merge_approvals',
] as const;
```

- [ ] **Step 3: Generate the initial migration**

Run: `npm run db:generate -- --name=init`
Expected:
- `packages/db/migrations/0000_init.sql` contains `CREATE TABLE \`user_stories\`` with `CONSTRAINT "story_blocked_ck" CHECK(...)`, the unique and partial indexes, and 28 `CREATE TABLE` statements.
- `packages/db/migrations/meta/_journal.json` exists.

Verify with `Select-String -Path packages/db/migrations/0000_init.sql -Pattern 'CREATE TABLE' | Measure-Object`, which should give Count 28.

- [ ] **Step 4: Create the immutability-trigger migration**

Run: `npm run db:generate -- --custom --name=immutability_triggers`
Expected: an empty `packages/db/migrations/0001_immutability_triggers.sql` is created and registered in `_journal.json`. Replace its content with:

```sql
CREATE TRIGGER `story_events_no_update` BEFORE UPDATE ON `story_events` BEGIN SELECT RAISE(ABORT, 'story_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `story_events_no_delete` BEFORE DELETE ON `story_events` BEGIN SELECT RAISE(ABORT, 'story_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_update` BEFORE UPDATE ON `reviews` BEGIN SELECT RAISE(ABORT, 'reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_delete` BEFORE DELETE ON `reviews` BEGIN SELECT RAISE(ABORT, 'reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_findings_no_update` BEFORE UPDATE ON `review_findings` BEGIN SELECT RAISE(ABORT, 'review_findings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_findings_no_delete` BEFORE DELETE ON `review_findings` BEGIN SELECT RAISE(ABORT, 'review_findings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_ac_results_no_update` BEFORE UPDATE ON `review_ac_results` BEGIN SELECT RAISE(ABORT, 'review_ac_results is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_ac_results_no_delete` BEFORE DELETE ON `review_ac_results` BEGIN SELECT RAISE(ABORT, 'review_ac_results is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_checks_no_update` BEFORE UPDATE ON `verification_checks` BEGIN SELECT RAISE(ABORT, 'verification_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_checks_no_delete` BEFORE DELETE ON `verification_checks` BEGIN SELECT RAISE(ABORT, 'verification_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `merge_approvals_no_update` BEFORE UPDATE ON `merge_approvals` BEGIN SELECT RAISE(ABORT, 'merge_approvals is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `merge_approvals_no_delete` BEFORE DELETE ON `merge_approvals` BEGIN SELECT RAISE(ABORT, 'merge_approvals is append-only'); END;
```

- [ ] **Step 5: Write the failing tests**

```ts
// packages/db/test/open.test.ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseCorruptError, IMMUTABLE_TABLES, openDatabase, projects } from '../src/index.ts';
import { listBackups, restoreBackup } from '../src/backup.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-db-'));
function paths() {
  const dir = tmp();
  return { file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'backups'), migrationsFolder };
}

describe('openDatabase', () => {
  it('creates every table and the immutability triggers on a fresh file', () => {
    const p = paths();
    const { sqlite, backupFile, close } = openDatabase(p);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as { name: string }[];
    expect(tables).toHaveLength(28);
    const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    expect(triggers).toHaveLength(IMMUTABLE_TABLES.length * 2);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(backupFile).toBeNull(); // nothing to back up yet
    close();
  });

  it('backs up an existing database before migrating and keeps only the newest five', () => {
    const p = paths();
    openDatabase(p).close();
    let t = Date.UTC(2026, 9, 18, 12, 0, 0);
    for (let i = 0; i < 7; i++) {
      const o = openDatabase({ ...p, now: () => new Date((t += 1000)) });
      expect(o.backupFile).not.toBeNull();
      expect(fs.existsSync(o.backupFile!)).toBe(true);
      o.close();
    }
    expect(listBackups(p.backupsDir)).toHaveLength(5);
  });

  it('refuses to open a file that is not a database', () => {
    const p = paths();
    fs.writeFileSync(p.file, 'this is not a database, just text '.repeat(200));
    expect(() => openDatabase(p)).toThrow(DatabaseCorruptError);
  });

  it('refuses to open a database with a corrupted b-tree page', () => {
    const p = paths();
    const o = openDatabase(p);
    const now = new Date();
    for (let i = 0; i < 200; i++) {
      o.db.insert(projects).values({ key: `P${i}X`, name: `Project ${i}`, repoPath: `C:/repo/${i}`, baseBranch: 'main', settings: {} as never, createdAt: now, updatedAt: now }).run();
    }
    o.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    o.close();
    const fd = fs.openSync(p.file, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096); // overwrite page 2
    fs.closeSync(fd);
    expect(() => openDatabase(p)).toThrow(DatabaseCorruptError);
  });

  it('restoreBackup moves the corrupt file aside and restores the backup', () => {
    const p = paths();
    openDatabase(p).close();
    const second = openDatabase(p);
    const backup = second.backupFile!;
    second.close(); // Windows cannot rename a file that is still open
    fs.writeFileSync(p.file, 'garbage');
    const { movedAside } = restoreBackup(backup, p.file);
    expect(movedAside).not.toBeNull();
    expect(fs.readFileSync(movedAside!, 'utf8')).toBe('garbage');
    const db = new Database(p.file);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    db.close();
  });
});
```

```ts
// packages/db/test/constraints.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeApprovals, openDatabase, projects, storyEvents, userStories, workspaces, type OpenedDatabase } from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let o: OpenedDatabase;
let storyId: number;
const now = new Date();

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-db-'));
  o = openDatabase({ file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'b'), migrationsFolder });
  const p = o.db.insert(projects).values({ key: 'INV', name: 'Inv', repoPath: 'C:/r', baseBranch: 'main', settings: {} as never, createdAt: now, updatedAt: now }).returning().get();
  storyId = o.db.insert(userStories).values({ projectId: p.id, key: 'INV-1', title: 't', rank: 1, createdAt: now, updatedAt: now }).returning().get().id;
  return () => o.close();
});

describe('constraints', () => {
  it('story_events is append-only', () => {
    o.db.insert(storyEvents).values({ storyId, type: 'created', actor: 'human', createdAt: now }).run();
    expect(() => o.sqlite.prepare("UPDATE story_events SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => o.sqlite.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
  });

  it('rejects malformed SHAs', () => {
    expect(() => o.sqlite.prepare("UPDATE user_stories SET candidate_sha = 'abc' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare('UPDATE user_stories SET candidate_sha = ? WHERE id = ?').run('a'.repeat(64), storyId)).not.toThrow();
  });

  it('BLOCKED ⇔ blocked_reason', () => {
    expect(() => o.sqlite.prepare("UPDATE user_stories SET status = 'BLOCKED' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare("UPDATE user_stories SET blocked_reason = 'quota' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare("UPDATE user_stories SET status = 'BLOCKED', blocked_reason = 'quota' WHERE id = ?").run(storyId)).not.toThrow();
  });

  it('allows one non-removed workspace per path', () => {
    const w = { storyId, kind: 'story' as const, path: 'C:/wt/INV-1', createdAt: now };
    o.db.insert(workspaces).values({ ...w, status: 'removed' }).run();
    o.db.insert(workspaces).values({ ...w, status: 'active' }).run();
    expect(() => o.db.insert(workspaces).values({ ...w, status: 'preserved' }).run()).toThrow(/UNIQUE/);
  });

  it('merge approvals are unique per story, kind and SHA and immutable', () => {
    const a = { storyId, kind: 'merge' as const, commitSha: 'a'.repeat(40), approvedAt: now };
    o.db.insert(mergeApprovals).values(a).run();
    expect(() => o.db.insert(mergeApprovals).values(a).run()).toThrow(/UNIQUE/);
    expect(() => o.sqlite.prepare("UPDATE merge_approvals SET note = 'x'").run()).toThrow(/append-only/);
  });

  it('enforces foreign keys', () => {
    expect(() => o.db.insert(storyEvents).values({ storyId: 999, type: 'x', actor: 'human', createdAt: now }).run()).toThrow(/FOREIGN KEY/);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run packages/db`
Expected: FAIL with "Failed to load url ../src/index.ts".

- [ ] **Step 7: Implement backup, open and the index**

```ts
// packages/db/src/backup.ts
import fs from 'node:fs';
import path from 'node:path';

export const backupFileName = (d: Date): string => `app-${d.toISOString().replace(/[:.]/g, '-')}.db`;

export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function pruneBackups(dir: string, keep: number): void {
  const all = listBackups(dir);
  for (const file of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(file, { force: true });
}

/** Restores `backupFile` over `targetFile`. The current file (and WAL/SHM) is renamed aside, never deleted. */
export function restoreBackup(backupFile: string, targetFile: string): { movedAside: string | null } {
  let movedAside: string | null = null;
  if (fs.existsSync(targetFile)) {
    movedAside = `${targetFile}.corrupt-${Date.now()}`;
    fs.renameSync(targetFile, movedAside);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(targetFile + suffix)) fs.renameSync(targetFile + suffix, `${movedAside ?? targetFile}${suffix}.aside`);
  }
  fs.copyFileSync(backupFile, targetFile);
  return { movedAside };
}
```

```ts
// packages/db/src/open.ts
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import fs from 'node:fs';
import path from 'node:path';
import { backupFileName, pruneBackups } from './backup.ts';
import * as schema from './schema.ts';

export type AikSchema = typeof schema;
export type AikDb = BetterSQLite3Database<AikSchema>;
export type AikTx = Parameters<Parameters<AikDb['transaction']>[0]>[0];
/** Accepts either the database or a transaction (both extend the base class). */
export type AikDbOrTx = BaseSQLiteDatabase<'sync', Database.RunResult, AikSchema>;

export class DatabaseCorruptError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`The database file is corrupt or is not a database: ${file}`, { cause });
    this.name = 'DatabaseCorruptError';
    this.file = file;
  }
}

export interface OpenDatabaseOptions {
  file: string;
  backupsDir: string;
  migrationsFolder: string;
  keepBackups?: number;
  now?: () => Date;
}

export interface OpenedDatabase {
  db: AikDb;
  sqlite: Database.Database;
  backupFile: string | null;
  close(): void;
}

function openChecked(file: string, existed: boolean): Database.Database {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(file);
    if (existed) {
      const result = sqlite.pragma('quick_check', { simple: true });
      if (result !== 'ok') throw new Error(`quick_check: ${String(result)}`);
    }
    return sqlite;
  } catch (err) {
    sqlite?.close();
    throw new DatabaseCorruptError(file, err);
  }
}

export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  const existed = fs.existsSync(opts.file) && fs.statSync(opts.file).size > 0;
  const sqlite = openChecked(opts.file, existed);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  let backupFile: string | null = null;
  if (existed) {
    fs.mkdirSync(opts.backupsDir, { recursive: true });
    backupFile = path.join(opts.backupsDir, backupFileName(opts.now?.() ?? new Date()));
    sqlite.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    pruneBackups(opts.backupsDir, opts.keepBackups ?? 5);
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder });
  return { db, sqlite, backupFile, close: () => sqlite.close() };
}
```

```ts
// packages/db/src/index.ts
export * from './backup.ts';
export * from './json-types.ts';
export * from './open.ts';
export * from './schema.ts';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run packages/db`
Expected: PASS (5 tests in `open.test.ts`, 6 in `constraints.test.ts`).

- [ ] **Step 9: Run the static checks**

Run: `npm run check:pins && npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/db package.json package-lock.json
git commit -m "feat(db): full SQLite schema, migrations with immutability triggers, backup and corruption handling"
```


---

### Task 5: Redaction and structured logging (FND-12)

**Files:**
- Create: `apps/orchestrator/package.json`
- Create: `apps/orchestrator/src/secrets/redactor.ts`, `apps/orchestrator/src/logging/rotating-file.ts`, `apps/orchestrator/src/logging/logger.ts`, `apps/orchestrator/src/time.ts`
- Test: `apps/orchestrator/test/redactor.test.ts`, `apps/orchestrator/test/logging.test.ts`

**Interfaces:**
- Produces:
  - `createRedactor(): Redactor`, where `Redactor = { addSecret(v: string): void; removeSecret(v: string): void; redact(text: string): string }`. The methods are closures, so they are safe to pass unbound.
  - `class RotatingFile { constructor(opts: { file: string; maxBytes: number; keep: number; transform?: (s: string) => string }); write(chunk: string): boolean; close(): void }`.
  - `createLogger(opts: { file: string; redactor: Redactor; level?: string; maxBytes?: number; keep?: number }): { logger: Logger; close(): void }`.
  - `type Clock = () => number` and `systemClock`.

- [ ] **Step 1: Create the orchestrator package**

```json
// apps/orchestrator/package.json
{
  "name": "@aik/orchestrator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "dependencies": {
    "@aik/contracts": "0.0.0",
    "@aik/db": "0.0.0",
    "@aik/workflow": "0.0.0",
    "better-sqlite3": "13.0.3",
    "drizzle-orm": "0.45.4",
    "fastify": "5.12.7",
    "pino": "10.4.0",
    "zod": "4.6.7"
  }
}
```

```ts
// apps/orchestrator/src/time.ts
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

```ts
// apps/orchestrator/test/redactor.test.ts
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/secrets/redactor.ts';

describe('redactor patterns', () => {
  const r = createRedactor();
  it.each([
    ['GitHub user token', `token ghu_${'a'.repeat(36)} end`, 'token [REDACTED:github-token] end'],
    ['GitHub refresh token', `ghr_${'B'.repeat(76)}`, '[REDACTED:github-token]'],
    ['GitHub classic PAT', `ghp_${'c'.repeat(36)}`, '[REDACTED:github-token]'],
    ['GitHub fine-grained PAT', `github_pat_${'d'.repeat(82)}`, '[REDACTED:github-token]'],
    ['OpenAI-style key', `key=sk-proj-${'e'.repeat(40)}`, 'key=[REDACTED:api-key]'],
    ['Google API key', `AIza${'f'.repeat(35)}`, '[REDACTED:api-key]'],
    ['Authorization header', 'Authorization: Bearer abc.def.ghi', 'Authorization: [REDACTED]'],
    ['Proxy basic auth', 'proxy-authorization: Basic dXNlcjpwYXNz', 'proxy-authorization: [REDACTED]'],
    ['URL credentials', 'clone https://user:s3cret@github.com/o/r.git', 'clone https://[REDACTED]@github.com/o/r.git'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----', '[REDACTED:private-key]'],
  ])('%s', (_name, input, expected) => {
    expect(r.redact(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(r.redact('commit 1a2b3c on main; authorization required')).toBe('commit 1a2b3c on main; authorization required');
  });

  it('keeps JSON parseable when redacting an authorization field', () => {
    const line = JSON.stringify({ msg: 'req', authorization: 'Bearer abc123' });
    expect(JSON.parse(r.redact(line))).toEqual({ msg: 'req', authorization: '[REDACTED]' });
  });
});

describe('redactor live secrets', () => {
  it('redacts registered secrets, including their JSON-escaped form', () => {
    const r = createRedactor();
    const secret = 'pa"ss\\word-12345';
    r.addSecret(secret);
    expect(r.redact(`value ${secret} here`)).toBe('value [REDACTED:secret] here');
    expect(r.redact(JSON.stringify({ x: secret }))).toBe('{"x":"[REDACTED:secret]"}');
  });
  it('ignores very short values and can forget secrets', () => {
    const r = createRedactor();
    r.addSecret('short');
    expect(r.redact('a short note')).toBe('a short note');
    r.addSecret('long-enough-secret');
    r.removeSecret('long-enough-secret');
    expect(r.redact('long-enough-secret')).toBe('long-enough-secret');
  });
});
```

```ts
// apps/orchestrator/test/logging.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.ts';
import { RotatingFile } from '../src/logging/rotating-file.ts';
import { createRedactor } from '../src/secrets/redactor.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-log-'));

describe('RotatingFile', () => {
  it('rotates at maxBytes, keeps `keep` old files and applies the transform', () => {
    const file = path.join(tmp(), 'x.log');
    const f = new RotatingFile({ file, maxBytes: 100, keep: 2, transform: (s) => s.toUpperCase() });
    for (let i = 0; i < 10; i++) f.write(`line-${i}-${'x'.repeat(30)}\n`); // 38 bytes each
    f.close();
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(true);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toContain('LINE-9');
    expect(current).not.toContain('line-9');
  });
});

describe('createLogger', () => {
  it('writes JSON lines with secrets redacted', () => {
    const file = path.join(tmp(), 'orchestrator.log');
    const redactor = createRedactor();
    redactor.addSecret('launch-token-0123456789');
    const { logger, close } = createLogger({ file, redactor });
    logger.info({ token: 'launch-token-0123456789', remote: 'https://u:p@example.com/x.git' }, 'hello');
    close();
    const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(entry.msg).toBe('hello');
    expect(entry.token).toBe('[REDACTED:secret]');
    expect(entry.remote).toBe('https://[REDACTED]@example.com/x.git');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run apps/orchestrator/test/redactor.test.ts apps/orchestrator/test/logging.test.ts`
Expected: FAIL with "Failed to load url ../src/secrets/redactor.ts".

- [ ] **Step 4: Implement the redactor, rotating file and logger**

```ts
// apps/orchestrator/src/secrets/redactor.ts
export interface Redactor {
  addSecret(value: string): void;
  removeSecret(value: string): void;
  redact(text: string): string;
}

type Rule = { re: RegExp; replace: (match: string, ...groups: string[]) => string };

const RULES: Rule[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: () => '[REDACTED:private-key]' },
  { re: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g, replace: () => '[REDACTED:github-token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: () => '[REDACTED:github-token]' },
  { re: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/g, replace: () => '[REDACTED:api-key]' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => '[REDACTED:api-key]' },
  {
    re: /((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  { re: /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}[REDACTED]@` },
];

const MIN_SECRET_LENGTH = 8;
const jsonEscaped = (v: string): string => JSON.stringify(v).slice(1, -1);

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    addSecret(value) {
      if (value.length < MIN_SECRET_LENGTH) return;
      secrets.add(value);
      secrets.add(jsonEscaped(value));
    },
    removeSecret(value) {
      secrets.delete(value);
      secrets.delete(jsonEscaped(value));
    },
    redact(text) {
      let out = text;
      for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('[REDACTED:secret]');
      for (const rule of RULES) out = out.replace(rule.re, rule.replace);
      return out;
    },
  };
}
```

```ts
// apps/orchestrator/src/logging/rotating-file.ts
import fs from 'node:fs';
import path from 'node:path';

export interface RotatingFileOptions {
  file: string;
  maxBytes: number;
  keep: number;
  transform?: (chunk: string) => string;
}

/** Synchronous size-rotated log file: file, file.1 … file.<keep>. */
export class RotatingFile {
  private readonly opts: RotatingFileOptions;
  private fd: number;
  private size: number;

  constructor(opts: RotatingFileOptions) {
    this.opts = opts;
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    this.fd = fs.openSync(opts.file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  write(chunk: string): boolean {
    const text = this.opts.transform ? this.opts.transform(chunk) : chunk;
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.opts.maxBytes) this.rotate();
    fs.writeSync(this.fd, text);
    this.size += bytes;
    return true;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private rotate(): void {
    const { file, keep } = this.opts;
    fs.closeSync(this.fd);
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
    this.fd = fs.openSync(file, 'a');
    this.size = 0;
  }
}
```

```ts
// apps/orchestrator/src/logging/logger.ts
import { pino, type Logger } from 'pino';
import type { Redactor } from '../secrets/redactor.ts';
import { RotatingFile } from './rotating-file.ts';

export function createLogger(opts: { file: string; redactor: Redactor; level?: string; maxBytes?: number; keep?: number }): {
  logger: Logger;
  close(): void;
} {
  const destination = new RotatingFile({
    file: opts.file,
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
    keep: opts.keep ?? 5,
    transform: (line) => opts.redactor.redact(line),
  });
  const logger = pino({ level: opts.level ?? 'info', base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, destination);
  return { logger, close: () => destination.close() };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/redactor.test.ts apps/orchestrator/test/logging.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Run the static checks and commit**

Run: `npm run check:pins && npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator package.json package-lock.json
git commit -m "feat(orchestrator): secret redactor and size-rotated redacted JSON logging"
```

---

### Task 6: Workflow service with audit and outbox (FND-6, part 2)

**Files:**
- Create: `apps/orchestrator/src/events/bus.ts`, `apps/orchestrator/src/events/outbox.ts`
- Create: `apps/orchestrator/src/workflow/snapshot.ts`, `apps/orchestrator/src/workflow/service.ts`
- Create: `apps/orchestrator/test/helpers/db.ts`
- Test: `apps/orchestrator/test/workflow-service.test.ts`

**Interfaces:**
- Consumes:
  - `evaluate`, `provenanceFor` and the types `WorkflowEvent`, `Effect`, `TransitionId` from `@aik/workflow` (Task 3);
  - the `@aik/db` tables, `AikDb`, `AikTx` and `AikDbOrTx` (Task 4);
  - `Clock` and `Redactor` (Task 5).
- Produces:
  - `class EventBus { notify(seq: number): void; subscribe(fn: (seq: number) => void): () => void }`.
  - `appendOutbox(tx: AikDbOrTx, input: { topic: EventTopic; storyId: number | null; provenance: Provenance; data: unknown }, now: Date): number`.
  - `readOutboxAfter(db: AikDbOrTx, afterSeq: number, limit?: number): EventEnvelope[]`.
  - `outboxBounds(db: AikDbOrTx): { min: number | null; max: number | null }`.
  - `type StoryRow`, `getStoryRow(db, id)`, `loadSnapshot(db, storyId): { row; story: StorySnapshot; evidence: Evidence } | null`.
  - `class WorkflowService`:
    - `constructor({ db, bus, now?, redact?, beforeCommit? })`;
    - `transition(input: TransitionInput): TransitionOutcome`;
    - `transitionIn(tx: AikTx, input: TransitionInput): { outcome: TransitionOutcome; notifySeq: number | null }`.
  - `TransitionInput = { storyId: number; event: WorkflowEvent; expectedVersion?: number; actor: Actor; idempotencyKey?: string }`.
  - `TransitionOutcome = { ok: true; duplicate: boolean; transitionId: TransitionId | null; story: StoryRow } | { ok: false; code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'GUARD_FAILED'; failedGuards?: FailedGuard[] }`.
  - `Actor = 'human' | 'system' | \`agent:${Role}\``.
- Test helpers: `createTestDb()`, `seedProject(db, overrides?)`, `seedStory(db, projectId, overrides?)`, `seedAcceptanceCriterion(db, storyId, text?, revision?)`, `seedPlan(db, storyId, overrides?)`, `forceStory(db, id, patch)`, `TEST_PLAN`, `MIGRATIONS`.

- [ ] **Step 1: Write the event bus and outbox**

```ts
// apps/orchestrator/src/events/bus.ts
import { EventEmitter } from 'node:events';

/** In-process notification that new outbox rows were committed. Consumers re-read the outbox (pull model). */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  notify(seq: number): void {
    this.emitter.emit('outbox', seq);
  }

  subscribe(fn: (seq: number) => void): () => void {
    this.emitter.on('outbox', fn);
    return () => this.emitter.off('outbox', fn);
  }
}
```

```ts
// apps/orchestrator/src/events/outbox.ts
import type { EventEnvelope, EventTopic, Provenance } from '@aik/contracts';
import { outboxEvents, type AikDbOrTx } from '@aik/db';
import { asc, gt, sql } from 'drizzle-orm';

export interface OutboxInput {
  topic: EventTopic;
  storyId: number | null;
  provenance: Provenance;
  data: unknown;
}

export function appendOutbox(db: AikDbOrTx, input: OutboxInput, now: Date): number {
  const row = db
    .insert(outboxEvents)
    .values({ topic: input.topic, storyId: input.storyId, payload: { provenance: input.provenance, data: input.data }, createdAt: now })
    .returning({ seq: outboxEvents.seq })
    .get();
  return row.seq;
}

export function readOutboxAfter(db: AikDbOrTx, afterSeq: number, limit = 500): EventEnvelope[] {
  return db
    .select()
    .from(outboxEvents)
    .where(gt(outboxEvents.seq, afterSeq))
    .orderBy(asc(outboxEvents.seq))
    .limit(limit)
    .all()
    .map((r) => ({
      seq: r.seq,
      topic: r.topic as EventTopic,
      storyId: r.storyId,
      at: r.createdAt.getTime(),
      provenance: r.payload.provenance as Provenance,
      data: r.payload.data,
    }));
}

export function outboxBounds(db: AikDbOrTx): { min: number | null; max: number | null } {
  const row = db
    .select({ min: sql<number | null>`min(${outboxEvents.seq})`, max: sql<number | null>`max(${outboxEvents.seq})` })
    .from(outboxEvents)
    .get();
  return { min: row?.min ?? null, max: row?.max ?? null };
}
```

- [ ] **Step 2: Write the snapshot loader**

```ts
// apps/orchestrator/src/workflow/snapshot.ts
import {
  acceptanceCriteria, clarifications, durableJobs, mergeApprovals, merges, plans, reviewAcResults, reviewFindings, reviews,
  storyDependencies, userStories, verificationChecks, verificationRuns, type AikDbOrTx,
} from '@aik/db';
import type { Evidence, StorySnapshot } from '@aik/workflow';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

export type StoryRow = typeof userStories.$inferSelect;

export function getStoryRow(db: AikDbOrTx, id: number): StoryRow | undefined {
  return db.select().from(userStories).where(eq(userStories.id, id)).get();
}

const count = sql<number>`count(*)`;

/** Loads the story and every piece of evidence the state machine's guards need — straight from the DB. */
export function loadSnapshot(db: AikDbOrTx, storyId: number): { row: StoryRow; story: StorySnapshot; evidence: Evidence } | null {
  const row = getStoryRow(db, storyId);
  if (!row) return null;

  const currentAcs = db
    .select({ id: acceptanceCriteria.id })
    .from(acceptanceCriteria)
    .where(and(eq(acceptanceCriteria.storyId, storyId), isNull(acceptanceCriteria.supersededAt)))
    .all();

  const plan = db.select().from(plans).where(eq(plans.storyId, storyId)).orderBy(desc(plans.version)).limit(1).get();
  const openClarifications = plan
    ? (db.select({ n: count }).from(clarifications).where(and(eq(clarifications.planId, plan.id), isNull(clarifications.answer))).get()?.n ?? 0)
    : 0;

  const deps = db
    .select({ status: userStories.status })
    .from(storyDependencies)
    .innerJoin(userStories, eq(userStories.id, storyDependencies.dependsOnStoryId))
    .where(eq(storyDependencies.storyId, storyId))
    .all();

  const mergeJob = db
    .select({ id: durableJobs.id })
    .from(durableJobs)
    .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.kind, 'merge'), eq(durableJobs.status, 'leased')))
    .get();

  const cand = row.candidateSha;
  let verification: Evidence['verification'] = null;
  let review: Evidence['review'] = null;
  let mergeApprovalForCandidate = false;
  let merge: Evidence['merge'] = null;
  let postMergeVerificationPassed = false;

  if (cand) {
    const vr = db
      .select()
      .from(verificationRuns)
      .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, cand), eq(verificationRuns.trigger, 'candidate'), inArray(verificationRuns.status, ['passed', 'failed', 'error'])))
      .orderBy(desc(verificationRuns.id))
      .limit(1)
      .get();
    if (vr) {
      const mandatory = db
        .select({ status: verificationChecks.status })
        .from(verificationChecks)
        .where(and(eq(verificationChecks.verificationRunId, vr.id), eq(verificationChecks.mandatory, true)))
        .all();
      verification = {
        sha: cand,
        mandatoryAllPassed: vr.status === 'passed' && mandatory.length > 0 && mandatory.every((c) => c.status === 'passed'),
      };
    }

    const rv = db
      .select()
      .from(reviews)
      .where(and(eq(reviews.storyId, storyId), eq(reviews.commitSha, cand), eq(reviews.actor, 'agent')))
      .orderBy(desc(reviews.id))
      .limit(1)
      .get();
    if (rv) {
      const blocking = db
        .select({ n: count })
        .from(reviewFindings)
        .where(and(eq(reviewFindings.reviewId, rv.id), eq(reviewFindings.blocking, true), isNull(reviewFindings.priorFindingId)))
        .get()?.n ?? 0;
      const met = new Set(
        db.select({ id: reviewAcResults.acceptanceCriterionId }).from(reviewAcResults)
          .where(and(eq(reviewAcResults.reviewId, rv.id), eq(reviewAcResults.status, 'met'))).all().map((r) => r.id),
      );
      review = { sha: cand, verdict: rv.verdict, blockingFindings: blocking, allAcMet: currentAcs.length > 0 && currentAcs.every((a) => met.has(a.id)) };
    }

    mergeApprovalForCandidate = !!db
      .select({ id: mergeApprovals.id })
      .from(mergeApprovals)
      .where(and(eq(mergeApprovals.storyId, storyId), eq(mergeApprovals.kind, 'merge'), eq(mergeApprovals.commitSha, cand)))
      .get();

    const m = db.select().from(merges).where(and(eq(merges.storyId, storyId), eq(merges.approvedSha, cand))).orderBy(desc(merges.id)).limit(1).get();
    if (m) {
      // The merge job verifies that merged_sha contains the candidate before it records status 'succeeded'.
      merge = { succeeded: m.status === 'succeeded', mergedSha: m.mergedSha, containsCandidate: m.status === 'succeeded' };
      if (m.mergedSha) {
        postMergeVerificationPassed = !!db
          .select({ id: verificationRuns.id })
          .from(verificationRuns)
          .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, m.mergedSha), eq(verificationRuns.trigger, 'postmerge'), eq(verificationRuns.status, 'passed')))
          .get();
      }
    }
  }

  return {
    row,
    story: {
      status: row.status,
      planningStatus: row.planningStatus,
      hold: row.hold,
      revision: row.revision,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      candidateSha: row.candidateSha,
      candidateTree: row.candidateTree,
      blockedFrom: row.blockedFrom,
      blockedReason: row.blockedReason,
      activeRunId: row.activeRunId,
      title: row.title,
      description: row.description,
      currentAcceptanceCriteria: currentAcs.length,
    },
    evidence: {
      plan: plan ? { version: plan.version, status: plan.status, storyRevision: plan.storyRevision, openClarifications } : null,
      dependenciesDone: deps.every((d) => d.status === 'DONE'),
      mergeInProgress: !!mergeJob,
      verification,
      review,
      mergeApprovalForCandidate,
      merge,
      postMergeVerificationPassed,
    },
  };
}
```

- [ ] **Step 3: Write the test helpers and the failing service test**

```ts
// apps/orchestrator/test/helpers/db.ts
import { defaultProjectSettings, type PlanV1 } from '@aik/contracts';
import { acceptanceCriteria, openDatabase, plans, projects, userStories, type AikDb, type OpenedDatabase } from '@aik/db';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

export function createTestDb(): OpenedDatabase & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-orch-'));
  const o = openDatabase({ file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'backups'), migrationsFolder: MIGRATIONS });
  return { ...o, dir };
}

let counter = 0;
const now = () => new Date(1_700_000_000_000);

export function seedProject(db: AikDb, overrides: Partial<typeof projects.$inferInsert> = {}) {
  counter += 1;
  return db
    .insert(projects)
    .values({ key: `P${counter}A`, name: `Project ${counter}`, repoPath: `C:/repos/p${counter}`, baseBranch: 'main', settings: defaultProjectSettings(), createdAt: now(), updatedAt: now(), ...overrides })
    .returning()
    .get();
}

export function seedStory(db: AikDb, projectId: number, overrides: Partial<typeof userStories.$inferInsert> = {}) {
  counter += 1;
  return db
    .insert(userStories)
    .values({ projectId, key: `S-${counter}`, title: 'Inventory', description: 'CRUD', rank: counter * 1024, createdAt: now(), updatedAt: now(), ...overrides })
    .returning()
    .get();
}

export function seedAcceptanceCriterion(db: AikDb, storyId: number, text = 'Users can create records', revision = 1) {
  const ordinal = db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.storyId, storyId)).all().length + 1;
  return db.insert(acceptanceCriteria).values({ storyId, storyRevision: revision, ordinal, text, source: 'human', createdAt: now() }).returning().get();
}

export const TEST_PLAN: PlanV1 = {
  schemaVersion: 1, summary: 'Plan', assumptions: [], clarificationQuestions: [], acceptanceCriteria: [],
  subtasks: [{ id: '1', description: 'Do it', files: [] }], affectedFiles: [], requiredTests: [],
  migrations: { required: false, notes: '' }, securitySensitive: [], dependencyChanges: [], conflictsWith: [], complexity: 'S', risks: [],
};

export function seedPlan(db: AikDb, storyId: number, overrides: Partial<typeof plans.$inferInsert> = {}) {
  return db
    .insert(plans)
    .values({ storyId, version: 1, storyRevision: 1, content: TEST_PLAN, status: 'proposed', createdAt: now(), ...overrides })
    .returning()
    .get();
}

/** Test-only: put a story into an arbitrary state to set up a scenario (bypasses the workflow on purpose). */
export function forceStory(db: AikDb, id: number, patch: Partial<typeof userStories.$inferInsert>) {
  db.update(userStories).set(patch).where(eq(userStories.id, id)).run();
}
```

```ts
// apps/orchestrator/test/workflow-service.test.ts
import { durableJobs, outboxEvents, plans, storyEvents } from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { createRedactor } from '../src/secrets/redactor.ts';
import { getStoryRow } from '../src/workflow/snapshot.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, forceStory, seedAcceptanceCriterion, seedPlan, seedProject, seedStory } from './helpers/db.ts';

let t: ReturnType<typeof createTestDb>;
let bus: EventBus;
let notified: number[];
let storyId: number;
const redactor = createRedactor();
redactor.addSecret('abcdefgh-secret');

function service(beforeCommit?: () => void) {
  return new WorkflowService({ db: t.db, bus, now: () => 1_000, redact: redactor.redact, beforeCommit });
}

beforeEach(() => {
  t = createTestDb();
  bus = new EventBus();
  notified = [];
  bus.subscribe((s) => notified.push(s));
  const p = seedProject(t.db);
  const s = seedStory(t.db, p.id, { planningStatus: 'plan_proposed' });
  seedAcceptanceCriterion(t.db, s.id);
  seedPlan(t.db, s.id);
  storyId = s.id;
  return () => t.close();
});

const approve = { type: 'approve_plan', planVersion: 1 } as const;
const counts = () => ({
  events: t.db.select().from(storyEvents).all().length,
  outbox: t.db.select().from(outboxEvents).all().length,
});

describe('WorkflowService.transition', () => {
  it('applies a valid transition atomically with audit, outbox, effects and notification', () => {
    const r = service().transition({ storyId, event: approve, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, duplicate: false, transitionId: 'T1', story: { status: 'READY', statusVersion: 1, planningStatus: 'plan_approved' } });
    const [ev] = t.db.select().from(storyEvents).all();
    expect(ev).toMatchObject({ storyId, type: 'transition', fromStatus: 'NEW', toStatus: 'READY', actor: 'human' });
    const [ob] = t.db.select().from(outboxEvents).all();
    expect(ob?.topic).toBe('story.transitioned');
    expect(ob?.payload.provenance).toBe('human_approval');
    expect(t.db.select().from(plans).get()).toMatchObject({ status: 'approved', approvedBy: 'human' });
    expect(notified).toEqual([ob?.seq]);
  });

  it('rejects a stale expectedVersion without writing anything', () => {
    expect(service().transition({ storyId, event: approve, expectedVersion: 3, actor: 'human' })).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
    expect(counts()).toEqual({ events: 0, outbox: 0 });
  });

  it('lets only one of two writers with the same expectedVersion win', () => {
    const wf = service();
    expect(wf.transition({ storyId, event: { type: 'hold' }, expectedVersion: 0, actor: 'human' }).ok).toBe(true);
    expect(wf.transition({ storyId, event: { type: 'unhold' }, expectedVersion: 0, actor: 'human' })).toEqual({ ok: false, code: 'VERSION_CONFLICT' });
  });

  it('returns failed guards and writes nothing when guards fail', () => {
    const r = service().transition({ storyId, event: { type: 'approve_plan', planVersion: 2 }, expectedVersion: 0, actor: 'human' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedGuards?.map((g) => g.guard)).toEqual(['plan_version']);
    expect(counts()).toEqual({ events: 0, outbox: 0 });
  });

  it('treats a repeated idempotency key as a no-op duplicate', () => {
    const wf = service();
    expect(wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human', idempotencyKey: 'k-1' })).toMatchObject({ ok: true, duplicate: false });
    expect(wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human', idempotencyKey: 'k-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(counts().events).toBe(1);
  });

  it('rolls back status, audit, outbox and effects when the commit fails', () => {
    const wf = service(() => {
      throw new Error('injected failure');
    });
    expect(() => wf.transition({ storyId, event: approve, expectedVersion: 0, actor: 'human' })).toThrow('injected failure');
    expect(getStoryRow(t.db, storyId)).toMatchObject({ status: 'NEW', statusVersion: 0 });
    expect(counts()).toEqual({ events: 0, outbox: 0 });
    expect(t.db.select().from(plans).get()?.status).toBe('proposed');
    expect(notified).toEqual([]);
  });

  it('cancel sets cancelledAt and cancels the story’s queued jobs', () => {
    const now = new Date();
    t.db.insert(durableJobs).values({ kind: 'plan', slot: 'heavy', storyId, payload: {}, sideEffecting: true, status: 'queued', runAfter: now, idempotencyKey: 'j1', createdAt: now, updatedAt: now }).run();
    const r = service().transition({ storyId, event: { type: 'cancel' }, expectedVersion: 0, actor: 'human' });
    expect(r).toMatchObject({ ok: true, story: { status: 'CANCELLED' } });
    if (r.ok) expect(r.story.cancelledAt).toBeInstanceOf(Date);
    expect(t.db.select().from(durableJobs).where(eq(durableJobs.storyId, storyId)).get()?.status).toBe('cancelled');
  });

  it('redacts secrets in blocked details', () => {
    forceStory(t.db, storyId, { status: 'IN_PROGRESS' });
    const r = service().transition({ storyId, event: { type: 'fail', reason: 'provider_down', detail: 'token abcdefgh-secret leaked' }, actor: 'system' });
    expect(r).toMatchObject({ ok: true, story: { status: 'BLOCKED', blockedReason: 'provider_down', blockedDetail: 'token [REDACTED:secret] leaked' } });
    expect(JSON.stringify(t.db.select().from(storyEvents).all())).not.toContain('abcdefgh-secret');
  });

  it('reports NOT_FOUND for an unknown story', () => {
    expect(service().transition({ storyId: 9999, event: { type: 'cancel' }, actor: 'human' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/workflow-service.test.ts`
Expected: FAIL with "Failed to load url ../src/workflow/service.ts".

- [ ] **Step 5: Implement the service**

```ts
// apps/orchestrator/src/workflow/service.ts
import type { FailedGuard, Role } from '@aik/contracts';
import { durableJobs, plans, storyEvents, userStories, type AikDb, type AikTx } from '@aik/db';
import { evaluate, provenanceFor, type Effect, type TransitionId, type WorkflowEvent } from '@aik/workflow';
import { and, eq, inArray } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import { systemClock, type Clock } from '../time.ts';
import { getStoryRow, loadSnapshot, type StoryRow } from './snapshot.ts';

export type Actor = 'human' | 'system' | `agent:${Role}`;

export interface TransitionInput {
  storyId: number;
  event: WorkflowEvent;
  /** Required for human requests; system callers may omit it to act on the current version. */
  expectedVersion?: number;
  actor: Actor;
  idempotencyKey?: string;
}

export type TransitionOutcome =
  | { ok: true; duplicate: boolean; transitionId: TransitionId | null; story: StoryRow }
  | { ok: false; code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'GUARD_FAILED'; failedGuards?: FailedGuard[] };

export interface WorkflowServiceDeps {
  db: AikDb;
  bus: EventBus;
  now?: Clock;
  redact?: (text: string) => string;
  /** Test hook: runs inside the transaction just before commit. */
  beforeCommit?: () => void;
}

/** The single authority over story status (spec §16). */
export class WorkflowService {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly now: Clock;
  private readonly redact: (text: string) => string;
  private readonly beforeCommit?: () => void;

  constructor(deps: WorkflowServiceDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
    this.redact = deps.redact ?? ((s) => s);
    this.beforeCommit = deps.beforeCommit;
  }

  transition(input: TransitionInput): TransitionOutcome {
    const { outcome, notifySeq } = this.db.transaction((tx) => this.transitionIn(tx, input), { behavior: 'immediate' });
    if (notifySeq !== null) this.bus.notify(notifySeq);
    return outcome;
  }

  /** Runs inside a caller-owned transaction. The caller must call `bus.notify(notifySeq)` after commit. */
  transitionIn(tx: AikTx, input: TransitionInput): { outcome: TransitionOutcome; notifySeq: number | null } {
    if (input.idempotencyKey) {
      const dup = tx.select({ id: storyEvents.id }).from(storyEvents).where(eq(storyEvents.idempotencyKey, input.idempotencyKey)).get();
      if (dup) {
        const story = getStoryRow(tx, input.storyId);
        return story
          ? { outcome: { ok: true, duplicate: true, transitionId: null, story }, notifySeq: null }
          : { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null };
      }
    }

    const snap = loadSnapshot(tx, input.storyId);
    if (!snap) return { outcome: { ok: false, code: 'NOT_FOUND' }, notifySeq: null };
    if (input.expectedVersion !== undefined && input.expectedVersion !== snap.row.statusVersion) {
      return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null };
    }

    const event: WorkflowEvent = input.event.type === 'fail' ? { ...input.event, detail: this.redact(input.event.detail) } : input.event;
    const result = evaluate(snap.story, snap.evidence, event);
    if (!result.ok) return { outcome: { ok: false, code: 'GUARD_FAILED', failedGuards: result.failedGuards }, notifySeq: null };

    const now = new Date(this.now());
    const updated = tx
      .update(userStories)
      .set({
        ...result.patch, // StoryPatch keys mirror userStories columns; Drizzle ignores undefined values in set()
        statusVersion: snap.row.statusVersion + 1,
        updatedAt: now,
        ...(result.to === 'DONE' && result.from !== 'DONE' ? { doneAt: now } : {}),
        ...(result.to === 'CANCELLED' ? { cancelledAt: now } : {}),
      })
      .where(and(eq(userStories.id, input.storyId), eq(userStories.statusVersion, snap.row.statusVersion)))
      .returning()
      .get();
    if (!updated) return { outcome: { ok: false, code: 'VERSION_CONFLICT' }, notifySeq: null };

    applyEffects(tx, input.storyId, result.effects, now);
    tx.insert(storyEvents)
      .values({
        storyId: input.storyId,
        type: 'transition',
        fromStatus: result.from,
        toStatus: result.to,
        actor: input.actor,
        payload: { transition: result.id, event, effects: result.effects },
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
      })
      .run();
    const notifySeq = appendOutbox(
      tx,
      {
        topic: 'story.transitioned',
        storyId: input.storyId,
        provenance: provenanceFor(event.type, result.to),
        data: { key: updated.key, from: result.from, to: result.to, transition: result.id, statusVersion: updated.statusVersion },
      },
      now,
    );
    this.beforeCommit?.();
    return { outcome: { ok: true, duplicate: false, transitionId: result.id, story: updated }, notifySeq };
  }
}

function applyEffects(tx: AikTx, storyId: number, effects: Effect[], now: Date): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'approve_plan':
        tx.update(plans)
          .set({ status: 'approved', approvedBy: effect.by, approvedAt: now })
          .where(and(eq(plans.storyId, storyId), eq(plans.version, effect.planVersion)))
          .run();
        break;
      case 'supersede_plan':
        tx.update(plans)
          .set({ status: 'superseded' })
          .where(and(eq(plans.storyId, storyId), inArray(plans.status, ['proposed', 'approved'])))
          .run();
        break;
      case 'cancel_jobs':
        tx.update(durableJobs)
          .set({ status: 'cancelled', updatedAt: now })
          .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.status, 'queued')))
          .run();
        break;
      case 'interrupt_active_run':
        // Executed by the agent runtime (Phase 2). It is recorded in the story event payload for audit.
        break;
    }
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/workflow-service.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Run the static checks and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator
git commit -m "feat(orchestrator): transactional WorkflowService with audit events, outbox and effects"
```

---

### Task 7: Durable job queue (FND-7)

**Files:**
- Create: `apps/orchestrator/src/jobs/queue.ts`
- Test: `apps/orchestrator/test/job-queue.test.ts`

**Interfaces:**
- Consumes: `durableJobs`, `JOB_KINDS`, `JOB_SLOTS` and `AikDb` (Task 4); `Clock` (Task 5).
- Produces:
  - `class JobQueue`:
    - `constructor(db: AikDb, opts?: { now?: Clock; leaseMs?: number; newToken?: () => string })`;
    - `enqueue(input: EnqueueInput): { id: number; created: boolean }`;
    - `claim(slot: JobSlot): LeasedJob | null`;
    - `heartbeat(jobId: number, leaseToken: string): boolean`;
    - `complete(jobId: number, leaseToken: string): boolean`;
    - `fail(jobId: number, leaseToken: string, error: string, opts?: { retry?: boolean; retryDelayMs?: number }): 'requeued' | 'failed' | 'dead' | 'stale'`;
    - `sweepExpired(): { requeued: number[]; dead: number[]; interrupted: { jobId: number; kind: JobKind; storyId: number | null }[] }`;
    - `cancelForStory(storyId: number): number`.
  - `EnqueueInput = { kind: JobKind; slot: JobSlot; storyId?: number | null; payload?: Record<string, unknown>; sideEffecting: boolean; idempotencyKey: string; runAfter?: number; maxAttempts?: number }`.
  - `LeasedJob = { id; kind; slot; storyId; payload; sideEffecting; attempts; maxAttempts; leaseToken: string; leaseExpiresAt: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/job-queue.test.ts
import { durableJobs } from '@aik/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/queue.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

let t: ReturnType<typeof createTestDb>;
let now: number;
let q: JobQueue;
let storyId: number;

beforeEach(() => {
  t = createTestDb();
  now = 1_000_000;
  let n = 0;
  q = new JobQueue(t.db, { now: () => now, leaseMs: 60_000, newToken: () => `tok-${++n}` });
  storyId = seedStory(t.db, seedProject(t.db).id).id;
  return () => t.close();
});

const job = (key: string, extra: Partial<Parameters<JobQueue['enqueue']>[0]> = {}) =>
  q.enqueue({ kind: 'implement', slot: 'heavy', storyId, sideEffecting: true, idempotencyKey: key, ...extra });
const statusOf = (id: number) => t.db.select().from(durableJobs).where(eq(durableJobs.id, id)).get()?.status;

describe('JobQueue', () => {
  it('ignores duplicate enqueues with the same idempotency key', () => {
    const a = job('story:1:implement:1');
    const b = job('story:1:implement:1');
    expect(a).toEqual({ id: a.id, created: true });
    expect(b).toEqual({ id: a.id, created: false });
  });

  it('never leases two heavy jobs at once, but light jobs are independent', () => {
    job('h1');
    job('h2');
    q.enqueue({ kind: 'pr_poll', slot: 'light', sideEffecting: false, idempotencyKey: 'l1' });
    const first = q.claim('heavy');
    expect(first?.leaseToken).toBe('tok-1');
    expect(q.claim('heavy')).toBeNull();
    expect(q.claim('light')?.kind).toBe('pr_poll');
  });

  it('respects runAfter', () => {
    job('later', { runAfter: now + 5_000 });
    expect(q.claim('heavy')).toBeNull();
    now += 5_000;
    expect(q.claim('heavy')).not.toBeNull();
  });

  it('heartbeat and completion require the current lease token', () => {
    const { id } = job('h1');
    const leased = q.claim('heavy')!;
    expect(q.heartbeat(id, 'wrong')).toBe(false);
    now += 50_000;
    expect(q.heartbeat(id, leased.leaseToken)).toBe(true);
    now += 50_000; // still within the extended lease
    expect(q.claim('heavy')).toBeNull();
    expect(q.complete(id, 'wrong')).toBe(false);
    expect(q.complete(id, leased.leaseToken)).toBe(true);
    expect(statusOf(id)).toBe('succeeded');
    expect(q.complete(id, leased.leaseToken)).toBe(false);
  });

  it('retries with backoff until maxAttempts, then dead-letters', () => {
    const { id } = job('h1', { maxAttempts: 2, sideEffecting: false });
    let l = q.claim('heavy')!;
    expect(q.fail(id, l.leaseToken, 'boom', { retry: true, retryDelayMs: 1_000 })).toBe('requeued');
    expect(q.claim('heavy')).toBeNull();
    now += 1_000;
    l = q.claim('heavy')!;
    expect(l.attempts).toBe(2);
    expect(q.fail(id, l.leaseToken, 'boom again', { retry: true })).toBe('dead');
    expect(statusOf(id)).toBe('dead');
  });

  it('marks non-retryable failures failed and rejects stale tokens', () => {
    const { id } = job('h1');
    const l = q.claim('heavy')!;
    expect(q.fail(id, 'stale', 'x')).toBe('stale');
    expect(q.fail(id, l.leaseToken, 'x')).toBe('failed');
  });

  it('sweeps expired leases: side-effecting → interrupted, idempotent → requeued or dead', () => {
    const se = job('se');
    const idem = q.enqueue({ kind: 'verify', slot: 'light', storyId, sideEffecting: false, idempotencyKey: 'idem' });
    const last = q.enqueue({ kind: 'fetch', slot: 'light', sideEffecting: false, idempotencyKey: 'last', maxAttempts: 1 });
    q.claim('heavy');
    q.claim('light');
    now += 61_000;
    q.claim('light'); // expired light lease no longer blocks: claims `last`
    now += 61_000;
    const swept = q.sweepExpired();
    expect(swept.interrupted).toEqual([{ jobId: se.id, kind: 'implement', storyId }]);
    expect(swept.requeued).toEqual([idem.id]);
    expect(swept.dead).toEqual([last.id]);
    expect(statusOf(se.id)).toBe('failed');
  });

  it('cancelForStory cancels queued and leased jobs; a cancelled lease cannot complete', () => {
    const a = job('a');
    job('b');
    const l = q.claim('heavy')!;
    expect(q.cancelForStory(storyId)).toBe(2);
    expect(q.complete(a.id, l.leaseToken)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/job-queue.test.ts`
Expected: FAIL with "Failed to load url ../src/jobs/queue.ts".

- [ ] **Step 3: Implement the queue**

```ts
// apps/orchestrator/src/jobs/queue.ts
import { durableJobs, type AikDb, type JOB_KINDS, type JOB_SLOTS } from '@aik/db';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import crypto from 'node:crypto';
import { systemClock, type Clock } from '../time.ts';

export type JobKind = (typeof JOB_KINDS)[number];
export type JobSlot = (typeof JOB_SLOTS)[number];

export interface EnqueueInput {
  kind: JobKind;
  slot: JobSlot;
  storyId?: number | null;
  payload?: Record<string, unknown>;
  sideEffecting: boolean;
  idempotencyKey: string;
  runAfter?: number;
  maxAttempts?: number;
}

export interface LeasedJob {
  id: number;
  kind: JobKind;
  slot: JobSlot;
  storyId: number | null;
  payload: Record<string, unknown>;
  sideEffecting: boolean;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  leaseExpiresAt: number;
}

/** Durable at-least-once queue on SQLite with leases (spec §15, FND-7). One job per slot at a time. */
export class JobQueue {
  private readonly db: AikDb;
  private readonly now: Clock;
  private readonly leaseMs: number;
  private readonly newToken: () => string;

  constructor(db: AikDb, opts: { now?: Clock; leaseMs?: number; newToken?: () => string } = {}) {
    this.db = db;
    this.now = opts.now ?? systemClock;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.newToken = opts.newToken ?? (() => crypto.randomBytes(16).toString('hex'));
  }

  enqueue(input: EnqueueInput): { id: number; created: boolean } {
    const now = new Date(this.now());
    const inserted = this.db
      .insert(durableJobs)
      .values({
        kind: input.kind,
        slot: input.slot,
        storyId: input.storyId ?? null,
        payload: input.payload ?? {},
        sideEffecting: input.sideEffecting,
        status: 'queued',
        maxAttempts: input.maxAttempts ?? 3,
        runAfter: new Date(input.runAfter ?? this.now()),
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: durableJobs.idempotencyKey })
      .returning({ id: durableJobs.id })
      .get();
    if (inserted) return { id: inserted.id, created: true };
    const existing = this.db.select({ id: durableJobs.id }).from(durableJobs).where(eq(durableJobs.idempotencyKey, input.idempotencyKey)).get();
    if (!existing) throw new Error(`enqueue conflict without an existing row for ${input.idempotencyKey}`);
    return { id: existing.id, created: false };
  }

  claim(slot: JobSlot): LeasedJob | null {
    return this.db.transaction(
      (tx) => {
        const nowMs = this.now();
        const busy = tx
          .select({ id: durableJobs.id })
          .from(durableJobs)
          .where(and(eq(durableJobs.slot, slot), eq(durableJobs.status, 'leased'), gt(durableJobs.leaseExpiresAt, new Date(nowMs))))
          .get();
        if (busy) return null;
        const next = tx
          .select()
          .from(durableJobs)
          .where(and(eq(durableJobs.slot, slot), eq(durableJobs.status, 'queued'), lte(durableJobs.runAfter, new Date(nowMs))))
          .orderBy(asc(durableJobs.runAfter), asc(durableJobs.id))
          .limit(1)
          .get();
        if (!next) return null;
        const token = this.newToken();
        const row = tx
          .update(durableJobs)
          .set({
            status: 'leased',
            leaseToken: token,
            leaseExpiresAt: new Date(nowMs + this.leaseMs),
            heartbeatAt: new Date(nowMs),
            attempts: next.attempts + 1,
            updatedAt: new Date(nowMs),
          })
          .where(and(eq(durableJobs.id, next.id), eq(durableJobs.status, 'queued')))
          .returning()
          .get();
        if (!row) return null;
        return {
          id: row.id, kind: row.kind, slot: row.slot, storyId: row.storyId, payload: row.payload, sideEffecting: row.sideEffecting,
          attempts: row.attempts, maxAttempts: row.maxAttempts, leaseToken: token, leaseExpiresAt: nowMs + this.leaseMs,
        };
      },
      { behavior: 'immediate' },
    );
  }

  heartbeat(jobId: number, leaseToken: string): boolean {
    const nowMs = this.now();
    const r = this.db
      .update(durableJobs)
      .set({ leaseExpiresAt: new Date(nowMs + this.leaseMs), heartbeatAt: new Date(nowMs), updatedAt: new Date(nowMs) })
      .where(this.leaseMatches(jobId, leaseToken))
      .run();
    return r.changes === 1;
  }

  complete(jobId: number, leaseToken: string): boolean {
    const r = this.db
      .update(durableJobs)
      .set({ status: 'succeeded', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(this.now()) })
      .where(this.leaseMatches(jobId, leaseToken))
      .run();
    return r.changes === 1;
  }

  fail(jobId: number, leaseToken: string, error: string, opts: { retry?: boolean; retryDelayMs?: number } = {}): 'requeued' | 'failed' | 'dead' | 'stale' {
    return this.db.transaction(
      (tx) => {
        const job = tx.select().from(durableJobs).where(this.leaseMatches(jobId, leaseToken)).get();
        if (!job) return 'stale';
        const nowMs = this.now();
        const base = { leaseToken: null, leaseExpiresAt: null, lastError: error, updatedAt: new Date(nowMs) };
        if (opts.retry && job.attempts < job.maxAttempts) {
          tx.update(durableJobs).set({ ...base, status: 'queued', runAfter: new Date(nowMs + (opts.retryDelayMs ?? 0)) }).where(eq(durableJobs.id, jobId)).run();
          return 'requeued';
        }
        const status = opts.retry ? 'dead' : 'failed';
        tx.update(durableJobs).set({ ...base, status }).where(eq(durableJobs.id, jobId)).run();
        return status;
      },
      { behavior: 'immediate' },
    );
  }

  /** Recovery after a crash/restart (spec §6.10): never silently re-run side-effecting work. */
  sweepExpired(): { requeued: number[]; dead: number[]; interrupted: { jobId: number; kind: JobKind; storyId: number | null }[] } {
    return this.db.transaction(
      (tx) => {
        const nowMs = this.now();
        const expired = tx
          .select()
          .from(durableJobs)
          .where(and(eq(durableJobs.status, 'leased'), lte(durableJobs.leaseExpiresAt, new Date(nowMs))))
          .orderBy(asc(durableJobs.id))
          .all();
        const out = { requeued: [] as number[], dead: [] as number[], interrupted: [] as { jobId: number; kind: JobKind; storyId: number | null }[] };
        const clear = { leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(nowMs) };
        for (const j of expired) {
          if (j.sideEffecting) {
            tx.update(durableJobs).set({ ...clear, status: 'failed', lastError: 'interrupted: lease expired (orchestrator restart or crash)' }).where(eq(durableJobs.id, j.id)).run();
            out.interrupted.push({ jobId: j.id, kind: j.kind, storyId: j.storyId });
          } else if (j.attempts < j.maxAttempts) {
            tx.update(durableJobs).set({ ...clear, status: 'queued', runAfter: new Date(nowMs) }).where(eq(durableJobs.id, j.id)).run();
            out.requeued.push(j.id);
          } else {
            tx.update(durableJobs).set({ ...clear, status: 'dead', lastError: 'lease expired at max attempts' }).where(eq(durableJobs.id, j.id)).run();
            out.dead.push(j.id);
          }
        }
        return out;
      },
      { behavior: 'immediate' },
    );
  }

  cancelForStory(storyId: number): number {
    const r = this.db
      .update(durableJobs)
      .set({ status: 'cancelled', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(this.now()) })
      .where(and(eq(durableJobs.storyId, storyId), inArray(durableJobs.status, ['queued', 'leased'])))
      .run();
    return r.changes;
  }

  private leaseMatches(jobId: number, leaseToken: string) {
    return and(eq(durableJobs.id, jobId), eq(durableJobs.leaseToken, leaseToken), eq(durableJobs.status, 'leased'));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/job-queue.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the static checks and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator
git commit -m "feat(orchestrator): durable SQLite job queue with leases, heartbeats, retries and crash sweep"
```


---

### Task 8: Local API security layer (FND-4)

**Files:**
- Create: `apps/orchestrator/src/api/errors.ts`, `security.ts`, `idempotency.ts`, `server.ts`, `routes/health.ts`
- Test: `apps/orchestrator/test/api-security.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `ErrorCode`, `FailedGuard` and `UI_ORIGIN` from contracts; `apiIdempotency` and `AikDb` from the db package; `Clock`.
- Produces:
  - `class ApiHttpError extends Error { statusCode; code: ErrorCode; retryable; details?; failedGuards? }`;
  - `parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>` (throws a 400 `VALIDATION_FAILED`);
  - `installErrorHandling(app)`;
  - `securityHook({ token, getPort })`;
  - `mutation(app, deps: { db: AikDb; now: Clock }, method, url, handler: (req) => Promise<{ status: number; body: unknown }>)`;
  - `createApiServer({ token, getPort, logger? }): FastifyInstance`;
  - `registerHealthRoutes(app, { db, versions: { app: string; electron: string | null; node: string }, dataDir })`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/api-security.test.ts
import crypto from 'node:crypto';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mutation, parse } from '../src/api/idempotency.ts';
import { createApiServer } from '../src/api/server.ts';
import { registerHealthRoutes } from '../src/api/routes/health.ts';
import { createTestDb } from './helpers/db.ts';

const TOKEN = 'a'.repeat(43);
const PORT = 41234;
let t: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiServer>;
let counter = 0;

beforeEach(async () => {
  t = createTestDb();
  counter = 0;
  app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerHealthRoutes(app, { db: t.db, versions: { app: '0.1.0', electron: null, node: process.version }, dataDir: t.dir });
  mutation(app, { db: t.db, now: () => 1 }, 'POST', '/test/echo', async (req) => {
    const body = parse(z.object({ value: z.string().min(1) }).strict(), req.body);
    counter += 1;
    return { status: 201, body: { value: body.value, counter } };
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

const headers = (extra: Record<string, string> = {}) => ({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...extra });

describe('security hook', () => {
  it('serves health to an authenticated loopback request', async () => {
    const r = await app.inject({ method: 'GET', url: '/health', headers: headers() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', components: { db: 'ok' }, versions: { app: '0.1.0', opencode: null } });
  });
  it('rejects a missing or wrong token with 401', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/health', headers: { host: `127.0.0.1:${PORT}` } });
    const r2 = await app.inject({ method: 'GET', url: '/health', headers: headers({ authorization: `Bearer ${'b'.repeat(43)}` }) });
    expect([r1.statusCode, r2.statusCode]).toEqual([401, 401]);
    expect(r1.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token', retryable: false } });
  });
  it('rejects foreign Host headers (DNS rebinding) with 403', async () => {
    for (const host of ['evil.example', `127.0.0.1.nip.io:${PORT}`, `127.0.0.1:${PORT + 1}`]) {
      const r = await app.inject({ method: 'GET', url: '/health', headers: headers({ host }) });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('FORBIDDEN_ORIGIN');
    }
  });
  it('accepts localhost and the app origin, rejects other origins', async () => {
    expect((await app.inject({ method: 'GET', url: '/health', headers: headers({ host: `localhost:${PORT}`, origin: 'app://ui' }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health', headers: headers({ origin: 'https://evil.example' }) })).statusCode).toBe(403);
  });
  it('returns the envelope for unknown routes', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope', headers: headers() });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});

describe('mutations', () => {
  const post = (payload: unknown, key?: string) =>
    app.inject({ method: 'POST', url: '/test/echo', headers: headers(key ? { 'idempotency-key': key } : {}), payload: payload as object });

  it('require an Idempotency-Key', async () => {
    const r = await post({ value: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_FAILED');
  });
  it('replay the stored response for a repeated key without re-running the handler', async () => {
    const key = crypto.randomUUID();
    const a = await post({ value: 'x' }, key);
    const b = await post({ value: 'x' }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(counter).toBe(1);
  });
  it('reject a reused key with a different body (422)', async () => {
    const key = crypto.randomUUID();
    await post({ value: 'x' }, key);
    const r = await post({ value: 'y' }, key);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
  it('validate bodies with details', async () => {
    const r = await post({ value: '' }, crypto.randomUUID());
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    expect(Array.isArray(r.json().error.details)).toBe(true);
  });
});

describe('binding', () => {
  it('is not reachable on non-loopback interfaces', async () => {
    let port = 0;
    const live = createApiServer({ token: TOKEN, getPort: () => port });
    await live.listen({ host: '127.0.0.1', port: 0 });
    port = (live.server.address() as AddressInfo).port;
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      await expect(fetch(`http://${external.address}:${port}/health`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
    }
    await live.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/api-security.test.ts`
Expected: FAIL with "Failed to load url ../src/api/idempotency.ts".

- [ ] **Step 3: Implement errors, security, idempotency, server and health**

```ts
// apps/orchestrator/src/api/errors.ts
import type { ApiError, ErrorCode, FailedGuard } from '@aik/contracts';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class ApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly failedGuards?: FailedGuard[];

  constructor(statusCode: number, code: ErrorCode, message: string, extra: { retryable?: boolean; details?: unknown; failedGuards?: FailedGuard[] } = {}) {
    super(message);
    this.name = 'ApiHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.details = extra.details;
    this.failedGuards = extra.failedGuards;
  }
}

export function toEnvelope(err: unknown): { status: number; body: ApiError } {
  if (err instanceof ApiHttpError) {
    const error: ApiError['error'] = { code: err.code, message: err.message, retryable: err.retryable };
    if (err.details !== undefined) error.details = err.details;
    if (err.failedGuards !== undefined) error.failedGuards = err.failedGuards;
    return { status: err.statusCode, body: { error } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'Invalid request', retryable: false, details: err.issues } } };
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, body: { error: { code: 'VALIDATION_FAILED', message: (err as Error).message, retryable: false } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal error', retryable: true } } };
}

export function installErrorHandling(app: FastifyInstance, onInternal?: (err: unknown) => void): void {
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toEnvelope(err);
    if (status >= 500) onInternal?.(err);
    void reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url}`, retryable: false } });
  });
}
```

```ts
// apps/orchestrator/src/api/security.ts
import { UI_ORIGIN } from '@aik/contracts';
import type { FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { ApiHttpError } from './errors.ts';

/** Loopback-only, DNS-rebinding-safe bearer authentication (spec §17.1, plan deviation 1 for Origin). */
export function securityHook(opts: { token: string; getPort: () => number }) {
  const expected = Buffer.from(opts.token);
  return async (req: FastifyRequest): Promise<void> => {
    const port = opts.getPort();
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new ApiHttpError(403, 'FORBIDDEN_ORIGIN', 'Host not allowed');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== UI_ORIGIN) {
      throw new ApiHttpError(403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
    }
    const auth = req.headers.authorization ?? '';
    const presented = Buffer.from(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '');
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      throw new ApiHttpError(401, 'UNAUTHORIZED', 'Missing or invalid token');
    }
  };
}
```

```ts
// apps/orchestrator/src/api/idempotency.ts
import { apiIdempotency, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../time.ts';
import { ApiHttpError } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiHttpError(400, 'VALIDATION_FAILED', z.prettifyError(r.error), { details: r.error.issues });
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Result = { status: number; body: unknown };

export function mutation(
  app: FastifyInstance,
  deps: { db: AikDb; now: Clock },
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  handler: (req: FastifyRequest) => Promise<Result>,
): void {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !UUID.test(key)) {
        throw new ApiHttpError(400, 'VALIDATION_FAILED', 'An Idempotency-Key header (UUID) is required for this request');
      }
      const route = `${method} ${url}`;
      const requestHash = crypto.createHash('sha256').update(`${route}\n${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
      const existing = deps.db.select().from(apiIdempotency).where(eq(apiIdempotency.key, key)).get();
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiHttpError(422, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request');
        }
        return reply.status(existing.responseStatus).send(existing.responseBody ?? undefined);
      }
      const result = await handler(req);
      deps.db
        .insert(apiIdempotency)
        .values({ key, route, requestHash, responseStatus: result.status, responseBody: result.body ?? null, createdAt: new Date(deps.now()) })
        .onConflictDoNothing()
        .run();
      return reply.status(result.status).send(result.body ?? undefined);
    },
  });
}
```

```ts
// apps/orchestrator/src/api/server.ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { installErrorHandling } from './errors.ts';
import { securityHook } from './security.ts';

export function createApiServer(opts: { token: string; getPort: () => number; logger?: Logger }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, forceCloseConnections: true, return503OnClosing: true });
  app.addHook('onRequest', securityHook({ token: opts.token, getPort: opts.getPort }));
  installErrorHandling(app, (err) => opts.logger?.error({ err }, 'request failed'));
  return app;
}
```

```ts
// apps/orchestrator/src/api/routes/health.ts
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: AikDb; versions: { app: string; electron: string | null; node: string }; dataDir: string },
): void {
  app.get('/health', async () => {
    let db: 'ok' | 'error' = 'ok';
    try {
      deps.db.$client.prepare('SELECT 1').get();
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      versions: { ...deps.versions, opencode: null },
      components: { db },
      dataDir: deps.dataDir,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/api-security.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the static checks and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator
git commit -m "feat(api): loopback bearer auth, host/origin checks, idempotent mutations and error envelope"
```

---

### Task 9: SSE event stream with replay (FND-8)

**Files:**
- Create: `apps/orchestrator/src/api/routes/events.ts`
- Test: `apps/orchestrator/test/sse.test.ts`

**Interfaces:**
- Consumes: `appendOutbox`, `readOutboxAfter`, `outboxBounds` and `EventBus` (Task 6); `createSseParser` and `formatSse` (Task 2).
- Produces: `registerEventRoutes(app, { db: AikDb; bus: EventBus; heartbeatMs?: number; now?: Clock })`.
  - `GET /events` streams `EventEnvelope` JSON with `id: <seq>`.
  - It honours `Last-Event-ID`.
  - It emits `system.resync` when the requested position has been pruned.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/sse.test.ts
import { createSseParser, type EventEnvelope } from '@aik/contracts';
import { outboxEvents } from '@aik/db';
import { lte } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerEventRoutes } from '../src/api/routes/events.ts';
import { createApiServer } from '../src/api/server.ts';
import { EventBus } from '../src/events/bus.ts';
import { appendOutbox } from '../src/events/outbox.ts';
import { createTestDb } from './helpers/db.ts';

const TOKEN = 't'.repeat(43);
let t: ReturnType<typeof createTestDb>;
let bus: EventBus;
let app: ReturnType<typeof createApiServer>;
let port = 0;

beforeEach(async () => {
  t = createTestDb();
  bus = new EventBus();
  app = createApiServer({ token: TOKEN, getPort: () => port });
  registerEventRoutes(app, { db: t.db, bus, heartbeatMs: 50 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(async () => {
  await app.close();
  t.close();
});

function emit(n: number): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) seqs.push(appendOutbox(t.db, { topic: 'story.updated', storyId: null, provenance: 'system', data: { i } }, new Date()));
  bus.notify(seqs.at(-1)!);
  return seqs;
}

async function connect(lastEventId?: number) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}) },
    signal: controller.signal,
  });
  const received: EventEnvelope[] = [];
  let raw = '';
  const parse = createSseParser((m) => received.push(JSON.parse(m.data) as EventEnvelope));
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        parse(text);
      }
    } catch {
      /* aborted */
    }
  })();
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for events');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { res, received, raw: () => raw, waitFor, close: () => controller.abort() };
}

describe('GET /events', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(401);
  });

  it('streams live events after connecting', async () => {
    const c = await connect();
    expect(c.res.headers.get('content-type')).toContain('text/event-stream');
    const [seq] = emit(1);
    await c.waitFor(() => c.received.length === 1);
    expect(c.received[0]).toMatchObject({ seq, topic: 'story.updated', provenance: 'system', data: { i: 0 } });
    c.close();
  });

  it('replays events after Last-Event-ID in order, without duplicates on later notifications', async () => {
    const seqs = emit(3);
    const c = await connect(seqs[0]);
    await c.waitFor(() => c.received.length === 2);
    bus.notify(seqs[2]!); // nothing new: must not resend
    await new Promise((r) => setTimeout(r, 100));
    expect(c.received.map((e) => e.seq)).toEqual([seqs[1], seqs[2]]);
    c.close();
  });

  it('replays more than one batch in order', async () => {
    const seqs = emit(1200);
    const c = await connect(0);
    await c.waitFor(() => c.received.length === 1200, 10_000);
    expect(c.received.map((e) => e.seq)).toEqual(seqs);
    c.close();
  });

  it('sends system.resync when the requested position was pruned', async () => {
    const seqs = emit(5);
    t.db.delete(outboxEvents).where(lte(outboxEvents.seq, seqs[2]!)).run();
    const c = await connect(seqs[0]);
    await c.waitFor(() => c.received.length >= 1);
    expect(c.received[0]?.topic).toBe('system.resync');
    c.close();
  });

  it('sends heartbeat comments', async () => {
    const c = await connect();
    await c.waitFor(() => c.raw().includes(': hb'));
    c.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/sse.test.ts`
Expected: FAIL with "Failed to load url ../src/api/routes/events.ts".

- [ ] **Step 3: Implement the route**

```ts
// apps/orchestrator/src/api/routes/events.ts
import { formatSse, type EventEnvelope } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../../events/bus.ts';
import { outboxBounds, readOutboxAfter } from '../../events/outbox.ts';
import { systemClock, type Clock } from '../../time.ts';

const BATCH = 500;

export function registerEventRoutes(app: FastifyInstance, deps: { db: AikDb; bus: EventBus; heartbeatMs?: number; now?: Clock }): void {
  const now = deps.now ?? systemClock;
  app.get('/events', (req, reply) => {
    const header = req.headers['last-event-id'];
    const requested = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : null;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.flushHeaders();

    const bounds = outboxBounds(deps.db);
    let lastSent = requested ?? bounds.max ?? 0;
    if (requested !== null && bounds.min !== null && requested < bounds.min - 1) {
      const resync: EventEnvelope = { seq: bounds.max ?? requested, topic: 'system.resync', storyId: null, at: now(), provenance: 'system', data: { reason: 'replay window exceeded' } };
      res.write(formatSse({ id: resync.seq, data: JSON.stringify(resync) }));
      lastSent = resync.seq;
    }

    const flush = () => {
      for (;;) {
        const batch = readOutboxAfter(deps.db, lastSent, BATCH);
        for (const ev of batch) {
          res.write(formatSse({ id: ev.seq, data: JSON.stringify(ev) }));
          lastSent = ev.seq;
        }
        if (batch.length < BATCH) break;
      }
    };
    flush();
    const unsubscribe = deps.bus.subscribe(flush);
    const heartbeat = setInterval(() => res.write(': hb\n\n'), deps.heartbeatMs ?? 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/sse.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the static checks and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator
git commit -m "feat(api): authenticated SSE stream with Last-Event-ID replay, paging, resync and heartbeat"
```

---

### Task 10: Local project registration (FND-9)

**Files:**
- Create: `apps/orchestrator/src/git/git.ts`, `apps/orchestrator/src/projects/service.ts`, `apps/orchestrator/src/api/routes/projects.ts`
- Create: `apps/orchestrator/test/helpers/temp.ts`
- Test: `apps/orchestrator/test/projects.test.ts`

**Interfaces:**
- Consumes: `CreateProjectRequest`, `PatchProjectRequest`, `ProjectDTO`, `defaultProjectSettings` (Task 2); `projects` table; `ApiHttpError`, `mutation`, `parse` (Task 8).
- Produces:
  - `git(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string>`;
  - `class GitError extends Error { args: string[]; stderr: string }`;
  - `stripCredentials(url: string): string`;
  - `class ProjectService`:
    - `constructor({ db, now? })`;
    - `list(): ProjectDTO[]`;
    - `get(id: number): ProjectDTO`;
    - `create(input: CreateProjectRequest): Promise<ProjectDTO>`;
    - `patch(id: number, input: PatchProjectRequest): ProjectDTO`;
    - `refreshAvailability(): Promise<void>`.
  - `registerProjectRoutes(app, { db, now, projects: ProjectService })`:
    - `GET /projects`, `POST /projects` (201), `GET /projects/:id`, `PATCH /projects/:id`.
- Test helpers: `makeTempDir(prefix?)`, `assertInTemp(path)`, `makeTempRepo(opts?: { name?: string })`, `makeTempRemoteAndClone()`.

- [ ] **Step 1: Write the temp helpers (with the safety guard)**

```ts
// apps/orchestrator/test/helpers/temp.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = () => fs.realpathSync.native(os.tmpdir()).toLowerCase();

/** Throws unless `p` resolves inside the OS temp directory — tests must never touch real repositories. */
export function assertInTemp(p: string): void {
  const real = fs.realpathSync.native(p).toLowerCase();
  if (!real.startsWith(tmpRoot() + path.sep)) throw new Error(`Refusing to operate outside the temp directory: ${real}`);
}

export function makeTempDir(prefix = 'aikanban-test-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const gitIn = (cwd: string, ...args: string[]) => {
  assertInTemp(cwd);
  return execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', ...args], { cwd, encoding: 'utf8' }).trim();
};

export function makeTempRepo(opts: { name?: string } = {}): string {
  const parent = makeTempDir('aikanban-test-repo-');
  const dir = path.join(parent, opts.name ?? 'repo');
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A bare "remote" whose default branch is `trunk`, plus a clone of it. */
export function makeTempRemoteAndClone(): { remote: string; clone: string } {
  const seed = makeTempRepo();
  gitIn(seed, 'branch', '-m', 'trunk');
  const remote = path.join(makeTempDir('aikanban-test-remote-'), 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const clone = path.join(makeTempDir('aikanban-test-clone-'), 'clone');
  execFileSync('git', ['clone', '-q', remote, clone]);
  return { remote, clone };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/orchestrator/test/projects.test.ts
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProjectRoutes } from '../src/api/routes/projects.ts';
import { createApiServer } from '../src/api/server.ts';
import { ProjectService } from '../src/projects/service.ts';
import { createTestDb } from './helpers/db.ts';
import { makeTempDir, makeTempRemoteAndClone, makeTempRepo } from './helpers/temp.ts';

const TOKEN = 'p'.repeat(43);
const PORT = 41235;
let t: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiServer>;
let projects: ProjectService;

beforeEach(async () => {
  t = createTestDb();
  projects = new ProjectService({ db: t.db, now: () => 1_000 });
  app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now: () => 1_000, projects });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

const h = (mut = false) => ({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(mut ? { 'idempotency-key': crypto.randomUUID() } : {}) });
const create = (payload: object) => app.inject({ method: 'POST', url: '/projects', headers: h(true), payload });

describe('POST /projects', () => {
  it('registers a local repo with defaults', async () => {
    const repo = makeTempRepo();
    const r = await create({ name: 'Inventory', key: 'INV', repoPath: repo });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ key: 'INV', name: 'Inventory', baseBranch: 'main', remoteUrl: null, status: 'active', settings: { maxAttempts: 3 } });
    expect(r.json().repoPath.toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
  });

  it('stores the repository root when given a subfolder', async () => {
    const repo = makeTempRepo();
    fs.mkdirSync(path.join(repo, 'src'));
    const r = await create({ name: 'A', key: 'AA', repoPath: path.join(repo, 'src') });
    expect(r.json().repoPath.toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
  });

  it('detects the remote default branch and strips credentials from the remote URL', async () => {
    const { clone } = makeTempRemoteAndClone();
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://user:s3cret@example.com/o/r.git'], { cwd: clone });
    const r = await create({ name: 'C', key: 'CC', repoPath: clone });
    expect(r.json()).toMatchObject({ baseBranch: 'trunk', remoteUrl: 'https://example.com/o/r.git' });
  });

  it('rejects non-git folders, relative paths and missing folders', async () => {
    const plain = makeTempDir();
    for (const repoPath of [plain, 'relative\\path', path.join(plain, 'missing')]) {
      const r = await create({ name: 'X', key: 'XX', repoPath });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects duplicate keys', async () => {
    await create({ name: 'A', key: 'DUP', repoPath: makeTempRepo() });
    expect((await create({ name: 'B', key: 'DUP', repoPath: makeTempRepo() })).statusCode).toBe(400);
  });

  it('rejects the same repo spelled differently', async () => {
    const repo = makeTempRepo();
    await create({ name: 'A', key: 'ONE', repoPath: repo });
    const r = await create({ name: 'B', key: 'TWO', repoPath: `${repo.toUpperCase()}\\` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/already registered/);
  });

  it('accepts paths with spaces and non-ASCII', async () => {
    const repo = makeTempRepo({ name: 'My Repos Zoë app' });
    const r = await create({ name: 'Zoë', key: 'ZOE', repoPath: repo });
    expect(r.statusCode).toBe(201);
    expect(r.json().repoPath).toContain('Zoë');
  });
});

describe('GET/PATCH /projects', () => {
  it('lists, reads and patches settings', async () => {
    const created = (await create({ name: 'A', key: 'AB', repoPath: makeTempRepo() })).json();
    expect((await app.inject({ method: 'GET', url: '/projects', headers: h() })).json()).toHaveLength(1);
    const settings = { ...created.settings, maxAttempts: 5 };
    const p = await app.inject({ method: 'PATCH', url: `/projects/${created.id}`, headers: h(true), payload: { settings } });
    expect(p.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/projects/${created.id}`, headers: h() })).json().settings.maxAttempts).toBe(5);
    expect((await app.inject({ method: 'GET', url: '/projects/999', headers: h() })).statusCode).toBe(404);
  });

  it('marks a moved repository unavailable and back to active', async () => {
    const repo = makeTempRepo();
    const created = (await create({ name: 'A', key: 'MV', repoPath: repo })).json();
    fs.renameSync(repo, `${repo}-moved`);
    await projects.refreshAvailability();
    expect(projects.get(created.id).status).toBe('unavailable');
    fs.renameSync(`${repo}-moved`, repo);
    await projects.refreshAvailability();
    expect(projects.get(created.id).status).toBe('active');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/projects.test.ts`
Expected: FAIL with "Failed to load url ../src/api/routes/projects.ts".

- [ ] **Step 4: Implement git, the service and the routes**

```ts
// apps/orchestrator/src/git/git.ts
import { execFile } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], cause: unknown, stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}`, { cause });
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

/** Runs git with interactive prompts and credential helpers disabled (spec §13.4). */
export function git(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, err, stderr));
      else resolve(stdout.trimEnd());
    });
  });
}

export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
}
```

```ts
// apps/orchestrator/src/projects/service.ts
import { ProjectSettings, defaultProjectSettings, type CreateProjectRequest, type PatchProjectRequest, type ProjectDTO } from '@aik/contracts';
import { projects, type AikDb } from '@aik/db';
import { eq, ne } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import { git, stripCredentials } from '../git/git.ts';
import { systemClock, type Clock } from '../time.ts';

type ProjectRow = typeof projects.$inferSelect;

const toDTO = (r: ProjectRow): ProjectDTO => ({
  id: r.id, key: r.key, name: r.name, repoPath: r.repoPath, baseBranch: r.baseBranch, remoteUrl: r.remoteUrl,
  status: r.status, settings: ProjectSettings.parse(r.settings), createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
});

const invalid = (message: string) => new ApiHttpError(400, 'VALIDATION_FAILED', message);
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function detectBaseBranch(root: string): Promise<string> {
  const remoteHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }).catch(() => '');
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  const current = await git(['branch', '--show-current'], { cwd: root }).catch(() => '');
  return current || 'main';
}

export class ProjectService {
  private readonly db: AikDb;
  private readonly now: Clock;

  constructor(deps: { db: AikDb; now?: Clock }) {
    this.db = deps.db;
    this.now = deps.now ?? systemClock;
  }

  list(): ProjectDTO[] {
    return this.db.select().from(projects).where(ne(projects.status, 'archived')).orderBy(projects.name).all().map(toDTO);
  }

  get(id: number): ProjectDTO {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Project ${id} not found`);
    return toDTO(row);
  }

  async create(input: CreateProjectRequest): Promise<ProjectDTO> {
    if (!path.isAbsolute(input.repoPath)) throw invalid('repoPath must be an absolute path');
    const requested = path.resolve(input.repoPath);
    if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw invalid(`Folder does not exist: ${requested}`);
    let top: string;
    try {
      top = await git(['rev-parse', '--show-toplevel'], { cwd: requested });
    } catch {
      throw invalid(`Folder is not inside a git repository: ${requested}`);
    }
    const root = fs.realpathSync.native(path.resolve(top));
    const existing = this.db.select().from(projects).all();
    if (existing.some((p) => p.key === input.key)) throw invalid(`Project key ${input.key} is already in use`);
    const clash = existing.find((p) => samePath(p.repoPath, root));
    if (clash) throw invalid(`This repository is already registered as ${clash.key}`);
    const baseBranch = input.baseBranch ?? (await detectBaseBranch(root));
    const remoteUrl = await git(['remote', 'get-url', 'origin'], { cwd: root }).then(stripCredentials, () => null);
    const now = new Date(this.now());
    const row = this.db
      .insert(projects)
      .values({ key: input.key, name: input.name, repoPath: root, baseBranch, remoteUrl, settings: defaultProjectSettings(), status: 'active', createdAt: now, updatedAt: now })
      .returning()
      .get();
    return toDTO(row);
  }

  patch(id: number, input: PatchProjectRequest): ProjectDTO {
    this.get(id);
    const row = this.db
      .update(projects)
      .set({ name: input.name, baseBranch: input.baseBranch, settings: input.settings, updatedAt: new Date(this.now()) })
      .where(eq(projects.id, id))
      .returning()
      .get();
    return toDTO(row!);
  }

  async refreshAvailability(): Promise<void> {
    for (const p of this.db.select().from(projects).where(ne(projects.status, 'archived')).all()) {
      const ok = fs.existsSync(p.repoPath) && (await git(['rev-parse', '--git-dir'], { cwd: p.repoPath }).then(() => true, () => false));
      const status = ok ? 'active' : 'unavailable';
      if (status !== p.status) this.db.update(projects).set({ status, updatedAt: new Date(this.now()) }).where(eq(projects.id, p.id)).run();
    }
  }
}
```

```ts
// apps/orchestrator/src/api/routes/projects.ts
import { CreateProjectRequest, PatchProjectRequest } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectService } from '../../projects/service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

export function registerProjectRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; projects: ProjectService }): void {
  app.get('/projects', async () => deps.projects.list());
  app.get('/projects/:id', async (req) => deps.projects.get(parse(IdParams, req.params).id));
  mutation(app, deps, 'POST', '/projects', async (req) => ({ status: 201, body: await deps.projects.create(parse(CreateProjectRequest, req.body)) }));
  mutation(app, deps, 'PATCH', '/projects/:id', async (req) => ({
    status: 200,
    body: deps.projects.patch(parse(IdParams, req.params).id, parse(PatchProjectRequest, req.body)),
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/projects.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Run the static checks and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/orchestrator
git commit -m "feat(projects): register local git repos with root/branch/remote detection and availability checks"
```

---

### Task 11: Stories API: CRUD, criteria, dependencies, transitions (FND-10)

**Files:**
- Create: `apps/orchestrator/src/stories/dto.ts`, `apps/orchestrator/src/stories/service.ts`, `apps/orchestrator/src/api/routes/stories.ts`
- Create: `apps/orchestrator/test/helpers/app.ts`
- Test: `apps/orchestrator/test/stories.test.ts`

**Interfaces:**
- Consumes:
  - `WorkflowService.transitionIn` and `TransitionOutcome` (Task 6). Queued jobs are cancelled through the workflow `cancel_jobs` effect, so `JobQueue` is not needed here;
  - `appendOutbox` and `EventBus` (Task 6);
  - `ApiHttpError`, `mutation` and `parse` (Task 8);
  - `IdParams` (Task 10);
  - `CreateStoryRequest`, `PatchStoryRequest`, `StoryListQuery`, `TransitionRequest`, `StoryDTO` and `BLOCKED_HINTS` (Task 2).
- Produces:
  - `toStoryDTO(db: AikDbOrTx, row: StoryRow): StoryDTO`.
  - `class StoryService`:
    - `constructor({ db, workflow, bus, now? })`;
    - `list(projectId, query): StoryDTO[]`;
    - `get(id): StoryDTO`;
    - `create(projectId, input): StoryDTO`;
    - `patch(id, input): StoryDTO`;
    - `transition(id, req, idempotencyKey?): StoryDTO`.
  - `registerStoryRoutes(app, { db, now, stories })`:
    - `GET /projects/:id/stories`, `POST /projects/:id/stories` (201);
    - `GET /stories/:id`, `PATCH /stories/:id`;
    - `POST /stories/:id/transitions`.
  - `outcomeToError(outcome)`, which maps a failed `TransitionOutcome` to `ApiHttpError` (404 / 409 `VERSION_CONFLICT` / 409 `GUARD_FAILED`).
- Test helper: `buildTestApp()` → `{ t, app, inject(method, url, payload?), services }` with auth headers and a fresh idempotency key per mutation.

- [ ] **Step 1: Write the test app helper**

```ts
// apps/orchestrator/test/helpers/app.ts
import crypto from 'node:crypto';
import { createApiServer } from '../../src/api/server.ts';
import { registerProjectRoutes } from '../../src/api/routes/projects.ts';
import { registerStoryRoutes } from '../../src/api/routes/stories.ts';
import { EventBus } from '../../src/events/bus.ts';
import { ProjectService } from '../../src/projects/service.ts';
import { createRedactor } from '../../src/secrets/redactor.ts';
import { StoryService } from '../../src/stories/service.ts';
import { WorkflowService } from '../../src/workflow/service.ts';
import { createTestDb } from './db.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41236;

export async function buildTestApp() {
  const t = createTestDb();
  const now = () => 1_700_000_000_000;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db: t.db, bus, now, redact: createRedactor().redact });
  const projects = new ProjectService({ db: t.db, now });
  const stories = new StoryService({ db: t.db, workflow, bus, now });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now, projects });
  registerStoryRoutes(app, { db: t.db, now, stories });
  await app.ready();
  const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = crypto.randomUUID()) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    });
  return { t, app, inject, bus, services: { workflow, projects, stories } };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/orchestrator/test/stories.test.ts
import { plans, reviews, storyEvents } from '@aik/db';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';
import { forceStory, seedPlan } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let projectId: number;

beforeEach(async () => {
  ctx = await buildTestApp();
  projectId = (await ctx.inject('POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() })).json().id;
});
afterEach(async () => {
  await ctx.app.close();
  ctx.t.close();
});

const createStory = async (body: object) => (await ctx.inject('POST', `/projects/${projectId}/stories`, body)).json();

describe('stories CRUD', () => {
  it('creates stories with sequential keys, criteria and defaults', async () => {
    const r = await ctx.inject('POST', `/projects/${projectId}/stories`, { title: 'Inventory module', description: 'CRUD', acceptanceCriteria: ['Create works', 'Search works'] });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      key: 'INV-1', status: 'NEW', statusVersion: 0, revision: 1, priority: 'P2', planningStatus: 'none', activePlanVersion: null,
      attempts: { used: 0, max: 3 }, blocked: null, acceptanceCriteria: [{ ordinal: 1, text: 'Create works' }, { ordinal: 2, text: 'Search works' }],
    });
    expect((await createStory({ title: 'Second' })).key).toBe('INV-2');
  });

  it('rejects unknown dependencies', async () => {
    const r = await ctx.inject('POST', `/projects/${projectId}/stories`, { title: 'X', dependsOn: ['INV-99'] });
    expect(r.statusCode).toBe(400);
  });

  it('lists with status, label, search and sort filters', async () => {
    await createStory({ title: 'Alpha', labels: ['backend'], priority: 'P1' });
    await createStory({ title: 'Beta', labels: ['ui'], priority: 'P0' });
    const all = (await ctx.inject('GET', `/projects/${projectId}/stories?sort=priority`)).json();
    expect(all.map((s: { title: string }) => s.title)).toEqual(['Beta', 'Alpha']);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?label=ui`)).json()).toHaveLength(1);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?q=alp`)).json()).toHaveLength(1);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?status=NEW,READY`)).json()).toHaveLength(2);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?status=BOGUS`)).statusCode).toBe(400);
  });

  it('search treats % and _ literally and round-trips emoji', async () => {
    await createStory({ title: '100% coverage 🚀' });
    await createStory({ title: 'snake_case naming' });
    await createStory({ title: 'plain title' });
    const pct = (await ctx.inject('GET', `/projects/${projectId}/stories?q=${encodeURIComponent('%')}`)).json();
    expect(pct.map((s: { title: string }) => s.title)).toEqual(['100% coverage 🚀']);
    const us = (await ctx.inject('GET', `/projects/${projectId}/stories?q=${encodeURIComponent('_')}`)).json();
    expect(us.map((s: { title: string }) => s.title)).toEqual(['snake_case naming']);
  });
});

describe('PATCH /stories/:id', () => {
  it('edits the definition in NEW: bumps revision and version', async () => {
    const s = await createStory({ title: 'Old', acceptanceCriteria: ['A'] });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, title: 'New', acceptanceCriteria: ['A2', 'B2'] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ title: 'New', revision: 2, statusVersion: 1, acceptanceCriteria: [{ text: 'A2' }, { text: 'B2' }] });
  });

  it('rejects a stale expectedVersion', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 7, title: 'Y' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('editing criteria in READY moves the story back to NEW and supersedes the plan (T2)', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedPlan(ctx.t.db, s.id, { status: 'approved' });
    forceStory(ctx.t.db, s.id, { status: 'READY', planningStatus: 'plan_approved' });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, acceptanceCriteria: ['A', 'B'] });
    expect(r.json()).toMatchObject({ status: 'NEW', planningStatus: 'none', revision: 2 });
    expect(ctx.t.db.select().from(plans).get()?.status).toBe('superseded');
  });

  it('refuses definition edits while work is active but allows labels', async () => {
    const s = await createStory({ title: 'X' });
    forceStory(ctx.t.db, s.id, { status: 'IN_PROGRESS' });
    const bad = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, description: 'changed' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.failedGuards[0].guard).toBe('editable_state');
    const ok = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, labels: ['urgent'] });
    expect(ok.json()).toMatchObject({ labels: ['urgent'], statusVersion: 1 });
  });

  it('rejects dependency cycles with the cycle path', async () => {
    const a = await createStory({ title: 'A' });
    const b = await createStory({ title: 'B', dependsOn: [a.key] });
    const r = await ctx.inject('PATCH', `/stories/${a.id}`, { expectedVersion: 0, dependsOn: [b.key] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('INV-1 → INV-2 → INV-1');
  });
});

describe('POST /stories/:id/transitions', () => {
  it('cancels and replays the same idempotency key without a second transition', async () => {
    const s = await createStory({ title: 'X' });
    const key = crypto.randomUUID();
    const a = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'cancel', expectedVersion: 0 }, key);
    const b = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'cancel', expectedVersion: 0 }, key);
    expect(a.json()).toMatchObject({ status: 'CANCELLED' });
    expect(b.json()).toEqual(a.json());
    expect(ctx.t.db.select().from(storyEvents).all().filter((e) => e.type === 'transition')).toHaveLength(1);
  });

  it('explains why a plan cannot be approved yet', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'approve_plan', planVersion: 1, expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('planning_status');
  });

  it('reports events whose components are not installed yet', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards[0].guard).toBe('feature_unavailable');
  });

  it('request_changes records a human review and moves AWAITING_MERGE → REWORK', async () => {
    const s = await createStory({ title: 'X' });
    forceStory(ctx.t.db, s.id, { status: 'AWAITING_MERGE', candidateSha: 'a'.repeat(40) });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'request_changes', sha: 'a'.repeat(40), findings: [{ text: 'Handle empty input' }], expectedVersion: 0 });
    expect(r.json()).toMatchObject({ status: 'REWORK' });
    expect(ctx.t.db.select().from(reviews).get()).toMatchObject({ actor: 'human', verdict: 'CHANGES_REQUESTED', commitSha: 'a'.repeat(40) });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/stories.test.ts`
Expected: FAIL with "Failed to load url ../../src/api/routes/stories.ts".

- [ ] **Step 4: Implement the DTO mapper, service and routes**

```ts
// apps/orchestrator/src/stories/dto.ts
import { BLOCKED_HINTS, type StoryDTO } from '@aik/contracts';
import { acceptanceCriteria, agentRuns, modelProfiles, plans, pullRequests, storyDependencies, userStories, type AikDbOrTx } from '@aik/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { StoryRow } from '../workflow/snapshot.ts';

export function toStoryDTO(db: AikDbOrTx, r: StoryRow): StoryDTO {
  const acs = db
    .select({ id: acceptanceCriteria.id, ordinal: acceptanceCriteria.ordinal, text: acceptanceCriteria.text })
    .from(acceptanceCriteria)
    .where(and(eq(acceptanceCriteria.storyId, r.id), isNull(acceptanceCriteria.supersededAt)))
    .orderBy(asc(acceptanceCriteria.ordinal))
    .all();
  const deps = db
    .select({ key: userStories.key })
    .from(storyDependencies)
    .innerJoin(userStories, eq(userStories.id, storyDependencies.dependsOnStoryId))
    .where(eq(storyDependencies.storyId, r.id))
    .orderBy(asc(userStories.id))
    .all()
    .map((d) => d.key);
  const plan = db
    .select({ version: plans.version })
    .from(plans)
    .where(and(eq(plans.storyId, r.id), inArray(plans.status, ['proposed', 'approved'])))
    .orderBy(desc(plans.version))
    .limit(1)
    .get();
  const run = r.activeRunId
    ? db
        .select({ id: agentRuns.id, role: agentRuns.role, startedAt: agentRuns.startedAt, model: modelProfiles.modelId })
        .from(agentRuns)
        .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.modelProfileId))
        .where(eq(agentRuns.id, r.activeRunId))
        .get()
    : undefined;
  const pr = db.select().from(pullRequests).where(eq(pullRequests.storyId, r.id)).orderBy(desc(pullRequests.id)).limit(1).get();
  return {
    id: r.id, key: r.key, projectId: r.projectId, title: r.title, description: r.description, priority: r.priority, rank: r.rank,
    labels: r.labels, complexity: r.complexity, revision: r.revision, status: r.status, statusVersion: r.statusVersion,
    planningStatus: r.planningStatus, activePlanVersion: plan?.version ?? null, hold: r.hold,
    blocked: r.blockedReason
      ? { reason: r.blockedReason, from: r.blockedFrom, detail: r.blockedDetail ?? '', hint: BLOCKED_HINTS[r.blockedReason] }
      : null,
    attempts: { used: r.attemptCount, max: r.maxAttempts },
    acceptanceCriteria: acs,
    dependsOn: deps,
    branch: r.branchName, candidateSha: r.candidateSha, mergedSha: r.mergedSha,
    activeRun: run ? { id: run.id, role: run.role, model: run.model ?? 'unknown', startedAt: run.startedAt?.getTime() ?? 0 } : null,
    pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}
```

```ts
// apps/orchestrator/src/stories/service.ts
import {
  STORY_STATUS, type CreateStoryRequest, type PatchStoryRequest, type StoryDTO, type StoryListQuery, type StoryStatus, type TransitionRequest,
} from '@aik/contracts';
import {
  acceptanceCriteria, projects, reviewFindings, reviews, storyDependencies, storyEvents, userStories, type AikDb, type AikTx,
} from '@aik/db';
import type { WorkflowEvent } from '@aik/workflow';
import { and, asc, desc, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { ApiHttpError } from '../api/errors.ts';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import { systemClock, type Clock } from '../time.ts';
import type { TransitionOutcome, WorkflowService } from '../workflow/service.ts';
import { getStoryRow, type StoryRow } from '../workflow/snapshot.ts';
import { toStoryDTO } from './dto.ts';

const EDITABLE: readonly StoryStatus[] = ['NEW', 'READY', 'BLOCKED'];
const PRIORITY_ORDER = sql`CASE ${userStories.priority} WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;
const UNAVAILABLE: Record<string, string> = {
  reject_plan: 'the planner', answer_clarifications: 'the planner', approve_publish: 'GitHub publishing',
  approve_merge: 'the merge pipeline', override_remote_review: 'GitHub integration',
};

export function outcomeToError(o: Extract<TransitionOutcome, { ok: false }>): ApiHttpError {
  if (o.code === 'NOT_FOUND') return new ApiHttpError(404, 'NOT_FOUND', 'Story not found');
  if (o.code === 'VERSION_CONFLICT') return new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed; reload and try again', { retryable: true });
  return new ApiHttpError(409, 'GUARD_FAILED', o.failedGuards?.map((g) => g.reason).join('; ') ?? 'Transition not allowed', { failedGuards: o.failedGuards });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class StoryService {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly now: Clock;

  constructor(deps: { db: AikDb; workflow: WorkflowService; bus: EventBus; now?: Clock }) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.now = deps.now ?? systemClock;
  }

  list(projectId: number, query: StoryListQuery): StoryDTO[] {
    const where: SQL[] = [eq(userStories.projectId, projectId)];
    if (query.status) {
      const statuses = query.status.split(',').map((s) => s.trim());
      const bad = statuses.filter((s) => !STORY_STATUS.includes(s as StoryStatus));
      if (bad.length) throw new ApiHttpError(400, 'VALIDATION_FAILED', `Unknown status: ${bad.join(', ')}`);
      where.push(inArray(userStories.status, statuses as StoryStatus[]));
    }
    if (query.label) where.push(sql`EXISTS (SELECT 1 FROM json_each(${userStories.labels}) WHERE json_each.value = ${query.label})`);
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      where.push(sql`(${userStories.title} LIKE ${pattern} ESCAPE '\\' OR ${userStories.description} LIKE ${pattern} ESCAPE '\\')`);
    }
    const order =
      query.sort === 'priority' ? [PRIORITY_ORDER, asc(userStories.rank)]
      : query.sort === 'updated' ? [desc(userStories.updatedAt)]
      : query.sort === 'created' ? [desc(userStories.createdAt)]
      : [asc(userStories.rank)];
    return this.db.select().from(userStories).where(and(...where)).orderBy(...order).all().map((r) => toStoryDTO(this.db, r));
  }

  get(id: number): StoryDTO {
    const row = getStoryRow(this.db, id);
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
    return toStoryDTO(this.db, row);
  }

  create(projectId: number, input: CreateStoryRequest): StoryDTO {
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const project = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ApiHttpError(404, 'NOT_FOUND', `Project ${projectId} not found`);
      if (project.status === 'archived') throw new ApiHttpError(400, 'VALIDATION_FAILED', 'Project is archived');
      const depIds = this.resolveKeys(tx, projectId, input.dependsOn);
      const now = new Date(this.now());
      const key = `${project.key}-${project.nextStoryNumber}`;
      tx.update(projects).set({ nextStoryNumber: project.nextStoryNumber + 1 }).where(eq(projects.id, projectId)).run();
      const maxRank = tx.select({ m: max(userStories.rank) }).from(userStories).where(eq(userStories.projectId, projectId)).get()?.m ?? 0;
      const row = tx
        .insert(userStories)
        .values({ projectId, key, title: input.title, description: input.description, priority: input.priority, labels: input.labels, rank: maxRank + 1024, maxAttempts: project.settings.maxAttempts ?? 3, createdAt: now, updatedAt: now })
        .returning()
        .get();
      this.insertCriteria(tx, row.id, 1, input.acceptanceCriteria, now);
      for (const depId of depIds) tx.insert(storyDependencies).values({ storyId: row.id, dependsOnStoryId: depId }).run();
      tx.insert(storyEvents).values({ storyId: row.id, type: 'created', toStatus: 'NEW', actor: 'human', payload: { key }, createdAt: now }).run();
      seq = appendOutbox(tx, { topic: 'story.updated', storyId: row.id, provenance: 'system', data: { key, change: 'created' } }, now);
      return toStoryDTO(tx, row);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  patch(id: number, input: PatchStoryRequest): StoryDTO {
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const row = getStoryRow(tx, id);
      if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
      if (row.statusVersion !== input.expectedVersion) {
        throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed; reload and try again', { retryable: true });
      }
      const defChange = input.title !== undefined || input.description !== undefined || input.acceptanceCriteria !== undefined;
      if ((defChange || input.dependsOn !== undefined) && !EDITABLE.includes(row.status)) {
        throw new ApiHttpError(409, 'GUARD_FAILED', `The story definition cannot be edited while it is ${row.status}`, {
          failedGuards: [{ guard: 'editable_state', reason: `Definition edits are allowed in ${EDITABLE.join(', ')} only` }],
        });
      }
      const now = new Date(this.now());
      let current: StoryRow = row;
      if (defChange) {
        const r = this.workflow.transitionIn(tx, { storyId: id, event: { type: 'edit_definition' }, expectedVersion: row.statusVersion, actor: 'human' });
        if (!r.outcome.ok) throw outcomeToError(r.outcome);
        seq = r.notifySeq;
        current = r.outcome.story;
        if (input.title !== undefined || input.description !== undefined) {
          tx.update(userStories).set({ title: input.title, description: input.description }).where(eq(userStories.id, id)).run();
        }
        if (input.acceptanceCriteria) {
          tx.update(acceptanceCriteria).set({ supersededAt: now }).where(and(eq(acceptanceCriteria.storyId, id), isNull(acceptanceCriteria.supersededAt))).run();
          this.insertCriteria(tx, id, current.revision, input.acceptanceCriteria, now);
        }
      }
      if (input.dependsOn !== undefined) this.replaceDependencies(tx, row, input.dependsOn);
      const simple = { priority: input.priority, labels: input.labels, rank: input.rank };
      const simpleChange = Object.values(simple).some((v) => v !== undefined) || input.dependsOn !== undefined;
      if (simpleChange) {
        tx.update(userStories)
          .set({ ...simple, updatedAt: now, ...(defChange ? {} : { statusVersion: row.statusVersion + 1 }) })
          .where(eq(userStories.id, id))
          .run();
        if (!defChange) {
          tx.insert(storyEvents).values({ storyId: id, type: 'edit', actor: 'human', payload: { fields: Object.keys(input).filter((k) => k !== 'expectedVersion') }, createdAt: now }).run();
          seq = appendOutbox(tx, { topic: 'story.updated', storyId: id, provenance: 'system', data: { key: row.key, change: 'edited' } }, now);
        }
      }
      return toStoryDTO(tx, getStoryRow(tx, id)!);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  transition(id: number, req: TransitionRequest, idempotencyKey?: string): StoryDTO {
    if (req.event in UNAVAILABLE) {
      throw new ApiHttpError(409, 'GUARD_FAILED', `${req.event} is not available yet`, {
        failedGuards: [{ guard: 'feature_unavailable', reason: `${req.event} is handled by ${UNAVAILABLE[req.event]}, which is not installed in this build` }],
      });
    }
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const event = this.toWorkflowEvent(req);
      const r = this.workflow.transitionIn(tx, { storyId: id, event, expectedVersion: req.expectedVersion, actor: 'human', idempotencyKey });
      if (!r.outcome.ok) throw outcomeToError(r.outcome);
      seq = r.notifySeq;
      if (req.event === 'request_changes' && !r.outcome.duplicate) this.recordHumanReview(tx, id, req);
      return toStoryDTO(tx, r.outcome.story);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  private toWorkflowEvent(req: TransitionRequest): WorkflowEvent {
    switch (req.event) {
      case 'approve_plan':
        return { type: 'approve_plan', planVersion: req.planVersion };
      case 'request_changes':
        return { type: 'request_changes', sha: req.sha };
      case 'recover':
        // Phase 1 has no component that can still be failing; Phase 2 replaces `true` with real cause checks.
        return { type: 'recover', target: req.target, extraAttempts: req.extraAttempts ?? 0, causeResolved: true };
      case 'cancel':
        return { type: 'cancel' };
      case 'hold':
        return { type: 'hold' };
      case 'unhold':
        return { type: 'unhold' };
      case 'stop_run':
        return { type: 'stop_run' };
      default:
        throw new ApiHttpError(409, 'GUARD_FAILED', `${req.event} is not available yet`);
    }
  }

  private recordHumanReview(tx: AikTx, storyId: number, req: Extract<TransitionRequest, { event: 'request_changes' }>): void {
    const now = new Date(this.now());
    const findings = req.findings.map((f, i) => ({
      id: `H-${i + 1}`, severity: 'high' as const, category: 'other' as const, file: f.file, evidence: f.text,
      explanation: f.text, recommendation: f.text, blocking: true,
    }));
    const review = tx
      .insert(reviews)
      .values({
        storyId, commitSha: req.sha, actor: 'human', agentRunId: null, rawVerdict: 'CHANGES_REQUESTED', verdict: 'CHANGES_REQUESTED',
        summary: 'Changes requested by a human at merge review',
        raw: { schemaVersion: 1, verdict: 'CHANGES_REQUESTED', summary: 'Changes requested by a human', acChecklist: [], findings, priorFindings: [] },
        createdAt: now,
      })
      .returning({ id: reviews.id })
      .get();
    for (const f of findings) {
      tx.insert(reviewFindings).values({
        reviewId: review.id, findingKey: f.id, severity: f.severity, category: f.category, filePath: f.file ?? null,
        evidence: f.evidence, explanation: f.explanation, recommendation: f.recommendation, blocking: true,
      }).run();
    }
  }

  private insertCriteria(tx: AikTx, storyId: number, revision: number, texts: string[], now: Date): void {
    texts.forEach((text, i) =>
      tx.insert(acceptanceCriteria).values({ storyId, storyRevision: revision, ordinal: i + 1, text, source: 'human', createdAt: now }).run(),
    );
  }

  private resolveKeys(tx: AikTx, projectId: number, keys: string[]): number[] {
    if (keys.length === 0) return [];
    const rows = tx.select({ id: userStories.id, key: userStories.key }).from(userStories)
      .where(and(eq(userStories.projectId, projectId), inArray(userStories.key, keys))).all();
    const missing = keys.filter((k) => !rows.some((r) => r.key === k));
    if (missing.length) throw new ApiHttpError(400, 'VALIDATION_FAILED', `Unknown dependency: ${missing.join(', ')}`);
    return rows.map((r) => r.id);
  }

  private replaceDependencies(tx: AikTx, story: StoryRow, keys: string[]): void {
    const depIds = this.resolveKeys(tx, story.projectId, keys);
    if (depIds.includes(story.id)) throw new ApiHttpError(400, 'VALIDATION_FAILED', 'A story cannot depend on itself');
    const all = tx
      .select({ from: storyDependencies.storyId, to: storyDependencies.dependsOnStoryId })
      .from(storyDependencies)
      .innerJoin(userStories, eq(userStories.id, storyDependencies.storyId))
      .where(eq(userStories.projectId, story.projectId))
      .all()
      .filter((e) => e.from !== story.id);
    const edges = new Map<number, number[]>();
    for (const e of [...all, ...depIds.map((to) => ({ from: story.id, to }))]) edges.set(e.from, [...(edges.get(e.from) ?? []), e.to]);
    const path = findPath(edges, story.id, story.id);
    if (path) {
      const keyOf = new Map(tx.select({ id: userStories.id, key: userStories.key }).from(userStories).where(eq(userStories.projectId, story.projectId)).all().map((r) => [r.id, r.key]));
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Dependency cycle: ${path.map((n) => keyOf.get(n)).join(' → ')}`);
    }
    tx.delete(storyDependencies).where(eq(storyDependencies.storyId, story.id)).run();
    for (const depId of depIds) tx.insert(storyDependencies).values({ storyId: story.id, dependsOnStoryId: depId }).run();
  }
}

/** Depth-first search for a path start → … → target (length ≥ 1). */
function findPath(edges: Map<number, number[]>, start: number, target: number): number[] | null {
  const stack: { node: number; path: number[] }[] = [{ node: start, path: [start] }];
  const seen = new Set<number>();
  while (stack.length) {
    const { node, path } = stack.pop()!;
    for (const next of edges.get(node) ?? []) {
      if (next === target) return [...path, next];
      if (!seen.has(next)) {
        seen.add(next);
        stack.push({ node: next, path: [...path, next] });
      }
    }
  }
  return null;
}
```

```ts
// apps/orchestrator/src/api/routes/stories.ts
import { CreateStoryRequest, PatchStoryRequest, StoryListQuery, TransitionRequest } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { StoryService } from '../../stories/service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';

export function registerStoryRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; stories: StoryService }): void {
  app.get('/projects/:id/stories', async (req) => deps.stories.list(parse(IdParams, req.params).id, parse(StoryListQuery, req.query)));
  app.get('/stories/:id', async (req) => deps.stories.get(parse(IdParams, req.params).id));
  mutation(app, deps, 'POST', '/projects/:id/stories', async (req) => ({
    status: 201,
    body: deps.stories.create(parse(IdParams, req.params).id, parse(CreateStoryRequest, req.body)),
  }));
  mutation(app, deps, 'PATCH', '/stories/:id', async (req) => ({
    status: 200,
    body: deps.stories.patch(parse(IdParams, req.params).id, parse(PatchStoryRequest, req.body)),
  }));
  mutation(app, deps, 'POST', '/stories/:id/transitions', async (req) => ({
    status: 200,
    body: deps.stories.transition(parse(IdParams, req.params).id, parse(TransitionRequest, req.body), req.headers['idempotency-key'] as string),
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/stories.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Run the full suite and static checks, then commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: no errors; all tests pass.

```bash
git add apps/orchestrator
git commit -m "feat(stories): story CRUD, versioned criteria, dependency cycles, search and human transitions"
```


---

### Task 12: Orchestrator entry and startup recovery (FND-3, orchestrator side)

**Files:**
- Create: `apps/orchestrator/src/config.ts`, `apps/orchestrator/src/app.ts`, `apps/orchestrator/src/main.ts`
- Test: `apps/orchestrator/test/app.test.ts`

**Interfaces:**
- Consumes: every orchestrator module from Tasks 5–11.
- Produces:
  - `dataPaths(root): { root, db, backups, logs, orchestratorLog, worktrees }`.
  - `startOrchestrator(opts: OrchestratorOptions): Promise<RunningOrchestrator>`.
    - `OrchestratorOptions = { dataDir; token; migrationsFolder; versions: { app; electron: string | null }; logLevel?; heartbeatMs? }`.
    - `RunningOrchestrator = { port: number; close(): Promise<void> }`.
  - `main.ts` speaks the utility-process protocol:
    - Receives `{ type: 'init', token, dataDir, migrationsFolder, versions, logLevel? }` and replies `{ type: 'ready', port }`, or `{ type: 'fatal', kind: 'database_corrupt' | 'startup_failed', message }` followed by exit code 3.
    - Receives `{ type: 'shutdown' }`, closes, and exits with code 0.
    - E2E-only hook: if `AIK_E2E=1` and `AIK_TEST_CRASH_ORCHESTRATOR=1`, it exits with code 1 on init.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/test/app.test.ts
import { DatabaseCorruptError, durableJobs, openDatabase } from '@aik/db';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/app.ts';
import { MIGRATIONS, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

const token = 'z'.repeat(43);
const opts = (dataDir: string) => ({ dataDir, token, migrationsFolder: MIGRATIONS, versions: { app: '0.1.0', electron: null }, heartbeatMs: 1000 });
const call = (port: number, method: string, p: string, body?: object) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('startOrchestrator', () => {
  it('serves the API, persists across restarts, backs up on restart and never logs the token', async () => {
    const dataDir = makeTempDir();
    let o = await startOrchestrator(opts(dataDir));
    expect((await call(o.port, 'GET', '/health')).status).toBe(200);
    expect((await call(o.port, 'POST', '/projects', { name: 'A', key: 'AA', repoPath: makeTempRepo() })).status).toBe(201);
    await o.close();

    o = await startOrchestrator(opts(dataDir));
    expect(await (await call(o.port, 'GET', '/projects')).json()).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toHaveLength(1);
    await o.close();

    const log = fs.readFileSync(path.join(dataDir, 'logs', 'orchestrator.log'), 'utf8');
    expect(log).toContain('orchestrator listening');
    expect(log).not.toContain(token);
  });

  it('refuses to start on a corrupt database', async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'app.db'), 'garbage '.repeat(500));
    await expect(startOrchestrator(opts(dataDir))).rejects.toBeInstanceOf(DatabaseCorruptError);
  });

  it('blocks stories whose side-effecting job was interrupted by a crash (never re-runs it)', async () => {
    const dataDir = makeTempDir();
    const pre = openDatabase({ file: path.join(dataDir, 'app.db'), backupsDir: path.join(dataDir, 'backups'), migrationsFolder: MIGRATIONS });
    const story = seedStory(pre.db, seedProject(pre.db).id, { status: 'IN_PROGRESS' });
    const past = new Date(Date.now() - 3_600_000);
    pre.db.insert(durableJobs).values({
      kind: 'implement', slot: 'heavy', storyId: story.id, payload: {}, sideEffecting: true, status: 'leased', leaseToken: 'old',
      leaseExpiresAt: past, attempts: 1, runAfter: past, idempotencyKey: 'crashed', createdAt: past, updatedAt: past,
    }).run();
    pre.close();

    const o = await startOrchestrator(opts(dataDir));
    const dto = await (await call(o.port, 'GET', `/stories/${story.id}`)).json();
    expect(dto).toMatchObject({ status: 'BLOCKED', blocked: { reason: 'interrupted', from: 'IN_PROGRESS' } });
    await o.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/app.test.ts`
Expected: FAIL with "Failed to load url ../src/app.ts".

- [ ] **Step 3: Implement config, app and main**

```ts
// apps/orchestrator/src/config.ts
import path from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  backups: string;
  logs: string;
  orchestratorLog: string;
  worktrees: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    db: path.join(root, 'app.db'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    orchestratorLog: path.join(root, 'logs', 'orchestrator.log'),
    worktrees: path.join(root, 'wt'),
  };
}
```

```ts
// apps/orchestrator/src/app.ts
import { openDatabase } from '@aik/db';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { registerEventRoutes } from './api/routes/events.ts';
import { registerHealthRoutes } from './api/routes/health.ts';
import { registerProjectRoutes } from './api/routes/projects.ts';
import { registerStoryRoutes } from './api/routes/stories.ts';
import { createApiServer } from './api/server.ts';
import { dataPaths } from './config.ts';
import { EventBus } from './events/bus.ts';
import { JobQueue } from './jobs/queue.ts';
import { createLogger } from './logging/logger.ts';
import { ProjectService } from './projects/service.ts';
import { createRedactor } from './secrets/redactor.ts';
import { StoryService } from './stories/service.ts';
import { systemClock } from './time.ts';
import { WorkflowService } from './workflow/service.ts';

export interface OrchestratorOptions {
  dataDir: string;
  token: string;
  migrationsFolder: string;
  versions: { app: string; electron: string | null };
  logLevel?: string;
  heartbeatMs?: number;
}

export interface RunningOrchestrator {
  port: number;
  close(): Promise<void>;
}

export async function startOrchestrator(opts: OrchestratorOptions): Promise<RunningOrchestrator> {
  const paths = dataPaths(opts.dataDir);
  fs.mkdirSync(paths.logs, { recursive: true });
  const redactor = createRedactor();
  redactor.addSecret(opts.token);
  const { logger, close: closeLog } = createLogger({ file: paths.orchestratorLog, redactor, level: opts.logLevel });

  let opened: ReturnType<typeof openDatabase>;
  try {
    opened = openDatabase({ file: paths.db, backupsDir: paths.backups, migrationsFolder: opts.migrationsFolder });
  } catch (err) {
    logger.error({ err }, 'database open failed');
    closeLog();
    throw err;
  }
  const db = opened.db;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db, bus, redact: redactor.redact });

  // Startup recovery (spec §6.10): side-effecting jobs whose lease expired are never re-run automatically.
  const swept = new JobQueue(db).sweepExpired();
  for (const job of swept.interrupted) {
    if (job.storyId === null) continue;
    const r = workflow.transition({
      storyId: job.storyId,
      event: { type: 'fail', reason: 'interrupted', detail: `The ${job.kind} job ${job.jobId} was interrupted by an orchestrator restart` },
      actor: 'system',
    });
    if (!r.ok) logger.warn({ jobId: job.jobId, storyId: job.storyId, code: r.code }, 'could not block story for interrupted job');
  }

  const projects = new ProjectService({ db });
  await projects.refreshAvailability();
  const stories = new StoryService({ db, workflow, bus });

  let port = 0;
  const app = createApiServer({ token: opts.token, getPort: () => port, logger });
  registerHealthRoutes(app, { db, versions: { ...opts.versions, node: process.versions.node }, dataDir: opts.dataDir });
  registerProjectRoutes(app, { db, now: systemClock, projects });
  registerStoryRoutes(app, { db, now: systemClock, stories });
  registerEventRoutes(app, { db, bus, heartbeatMs: opts.heartbeatMs });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
  logger.info({ port, recovered: swept }, 'orchestrator listening');

  return {
    port,
    close: async () => {
      await app.close();
      opened.close();
      logger.info('orchestrator stopped');
      closeLog();
    },
  };
}
```

```ts
// apps/orchestrator/src/main.ts
// Entry point inside an Electron utilityProcess. Speaks a tiny message protocol with the main process.
import { DatabaseCorruptError } from '@aik/db';
import { startOrchestrator, type OrchestratorOptions, type RunningOrchestrator } from './app.ts';

type InitMessage = { type: 'init' } & OrchestratorOptions;
type InboundMessage = InitMessage | { type: 'shutdown' };
interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('The orchestrator must run inside an Electron utilityProcess');
  process.exit(2);
}

let running: RunningOrchestrator | null = null;

parentPort.on('message', ({ data }) => {
  const msg = data as InboundMessage;
  if (msg.type === 'init' && running === null) {
    if (process.env.AIK_E2E === '1' && process.env.AIK_TEST_CRASH_ORCHESTRATOR === '1') process.exit(1);
    startOrchestrator(msg).then(
      (r) => {
        running = r;
        parentPort.postMessage({ type: 'ready', port: r.port });
      },
      (err: unknown) => {
        parentPort.postMessage({
          type: 'fatal',
          kind: err instanceof DatabaseCorruptError ? 'database_corrupt' : 'startup_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        process.exit(3);
      },
    );
  } else if (msg.type === 'shutdown') {
    void (running?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/app.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite and static checks, then commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: no errors; all tests pass.

```bash
git add apps/orchestrator
git commit -m "feat(orchestrator): startup wiring, crash recovery sweep and utility-process entry point"
```

---

### Task 13: Electron shell: supervisor, protocol, window hardening, IPC bridge (FND-2, FND-3)

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src/main/paths.ts`, `backoff.ts`, `supervisor.ts`, `ui-path.ts`, `links.ts`, `events-forwarder.ts`, `protocol.ts`, `window.ts`, `bridge.ts`, `index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/scripts/build.mjs`, `apps/desktop/scripts/dev.mjs`
- Test: `apps/desktop/test/supervisor.test.ts`, `ui-path.test.ts`, `links.test.ts`, `events-forwarder.test.ts`
- Modify: root `package.json` scripts

**Interfaces:**
- Consumes:
  - the `main.ts` protocol (Task 12);
  - `AikWindowApi`, `SystemState`, `BridgeResponse`, `createSseParser`, `APP_ID` and `APP_NAME` (Task 2);
  - `listBackups` and `restoreBackup` from `@aik/db/backup` (Task 4).
- Produces:
  - `class OrchestratorSupervisor extends EventEmitter`:
    - `constructor(opts: SupervisorOptions)`;
    - `start()`, `stop(timeoutMs?)`, `restart()`;
    - readable `state`, `port`, `fatal`, `child`;
    - events `'ready'`, `'down'`, `'crash-loop'`, `'fatal'`, `'state'`.
  - `restartDelay(n, schedule?)`.
  - `resolveUiFile(uiRoot, url)`, `contentTypeFor(file)` and `CSP`.
  - `isAllowedExternal(url)`.
  - `class EventForwarder { start(); stop() }`.
  - `resolveDataDir(env, localAppData)` and `desktopPaths(dataDir)`.
  - The renderer global `window.api: AikWindowApi`.
  - E2E-only global `__aik = { supervisor, dataDir, token }`, set only when `AIK_E2E=1`.

- [ ] **Step 1: Create the package, install Electron and esbuild, and add scripts**

```json
// apps/desktop/package.json
{
  "name": "@aik/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@aik/contracts": "0.0.0",
    "@aik/db": "0.0.0",
    "zod": "4.6.7"
  }
}
```

Run: `npm install -E -D electron@44.9.0 esbuild@0.28.2`, then `npm install`
Add the root scripts (edit `package.json` `scripts`):

```json
"build": "npm run build -w @aik/ui && node apps/desktop/scripts/build.mjs",
"build:shell": "node apps/desktop/scripts/build.mjs --no-ui",
"start": "electron apps/desktop/dist",
"dev": "node apps/desktop/scripts/dev.mjs"
```

- [ ] **Step 2: Write the failing unit tests**

```ts
// apps/desktop/test/supervisor.test.ts
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrchestratorSupervisor, type ChildLike } from '../src/main/supervisor.ts';

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  sent: unknown[] = [];
  killed = false;
  exitOnShutdown = true;
  postMessage(message: unknown): void {
    this.sent.push(message);
    if ((message as { type: string }).type === 'shutdown' && this.exitOnShutdown) queueMicrotask(() => this.emit('exit', 0));
  }
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 1);
    return true;
  }
}

let children: FakeChild[];
let timers: { fn: () => void; ms: number }[];
let now: number;
let sup: OrchestratorSupervisor;

beforeEach(() => {
  children = [];
  timers = [];
  now = 0;
  sup = new OrchestratorSupervisor({
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    initMessage: () => ({ type: 'init', token: 't' }),
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
});

const last = () => children.at(-1)!;
const runTimer = () => timers.shift()!.fn();

describe('OrchestratorSupervisor', () => {
  it('forks, sends init and becomes ready', () => {
    const ready: number[] = [];
    sup.on('ready', (p: number) => ready.push(p));
    sup.start();
    expect(last().sent).toEqual([{ type: 'init', token: 't' }]);
    expect(sup.state).toBe('starting');
    last().emit('message', { type: 'ready', port: 5555 });
    expect([sup.state, sup.port, ready]).toEqual(['ready', 5555, [5555]]);
  });

  it('restarts with exponential backoff and resets it after a successful start', () => {
    sup.start();
    last().emit('exit', 1);
    expect([sup.state, sup.port, timers.map((t) => t.ms)]).toEqual(['restarting', null, [1000]]);
    runTimer();
    last().emit('exit', 1);
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    runTimer();
    last().emit('message', { type: 'ready', port: 1 });
    last().emit('exit', 1);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
  });

  it('enters crash-loop after more than 5 crashes within 5 minutes', () => {
    sup.start();
    for (let i = 0; i < 5; i++) {
      last().emit('exit', 1);
      now += 1000;
      runTimer();
    }
    last().emit('exit', 1);
    expect(sup.state).toBe('crash-loop');
    expect(timers).toHaveLength(0);
  });

  it('does not count crashes older than the window', () => {
    sup.start();
    for (let i = 0; i < 6; i++) {
      last().emit('exit', 1);
      now += 61_000;
      runTimer();
    }
    expect(sup.state).toBe('starting');
  });

  it('stays down on a fatal report', () => {
    sup.start();
    last().emit('message', { type: 'fatal', kind: 'database_corrupt', message: 'bad' });
    last().emit('exit', 3);
    expect([sup.state, sup.fatal]).toEqual(['fatal', { kind: 'database_corrupt', message: 'bad' }]);
    expect(timers).toHaveLength(0);
  });

  it('ignores messages and exits from a replaced child', () => {
    sup.start();
    const old = last();
    old.emit('exit', 1);
    runTimer();
    old.emit('message', { type: 'ready', port: 9 });
    expect(sup.port).toBeNull();
  });

  it('stops gracefully, or kills after the timeout', async () => {
    sup.start();
    await sup.stop(50);
    expect(sup.state).toBe('stopped');
    expect(last().sent.at(-1)).toEqual({ type: 'shutdown' });
    expect(timers).toHaveLength(0);

    sup.start();
    last().exitOnShutdown = false;
    await sup.stop(20);
    expect(last().killed).toBe(true);
  });

  it('restart() clears crash-loop and fatal state', () => {
    sup.start();
    last().emit('message', { type: 'fatal', kind: 'startup_failed', message: 'x' });
    last().emit('exit', 3);
    sup.restart();
    expect([sup.state, sup.fatal, children.length]).toEqual(['starting', null, 2]);
  });
});
```

```ts
// apps/desktop/test/ui-path.test.ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveUiFile } from '../src/main/ui-path.ts';

const root = path.resolve('C:/app/ui');

describe('resolveUiFile', () => {
  it('maps app://ui URLs to files under the UI root', () => {
    expect(resolveUiFile(root, 'app://ui/')).toBe(path.join(root, 'index.html'));
    expect(resolveUiFile(root, 'app://ui/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveUiFile(root, 'app://ui/assets/main-abc.js')).toBe(path.join(root, 'assets', 'main-abc.js'));
  });
  it('blocks traversal, including encoded backslashes', () => {
    expect(resolveUiFile(root, 'app://ui/..%5c..%5cWindows%5cwin.ini')).toBeNull();
    expect(resolveUiFile(root, 'app://ui/%2e%2e%5csecret.txt')).toBeNull();
  });
  it('rejects other hosts and schemes', () => {
    expect(resolveUiFile(root, 'app://evil/index.html')).toBeNull();
    expect(resolveUiFile(root, 'file:///C:/app/ui/index.html')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('knows the bundle file types', () => {
    expect(contentTypeFor('a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('a.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream');
  });
});
```

```ts
// apps/desktop/test/links.test.ts
import { describe, expect, it } from 'vitest';
import { isAllowedExternal } from '../src/main/links.ts';

describe('isAllowedExternal', () => {
  it.each([
    ['https://github.com/o/r', true],
    ['https://docs.github.com/en', true],
    ['http://github.com/o/r', false],
    ['https://github.com.evil.example/x', false],
    ['https://user:pass@github.com/', false],
    ['javascript:alert(1)', false],
    ['file:///C:/Windows', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedExternal(url)).toBe(expected);
  });
});
```

```ts
// apps/desktop/test/events-forwarder.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventForwarder } from '../src/main/events-forwarder.ts';

let server: http.Server | undefined;
afterEach(() => server?.close());

describe('EventForwarder', () => {
  it('forwards events, reconnects, and resumes with Last-Event-ID', async () => {
    const seenHeaders: (string | undefined)[] = [];
    const seenAuth: (string | undefined)[] = [];
    let connections = 0;
    server = http.createServer((req, res) => {
      connections += 1;
      seenHeaders.push(req.headers['last-event-id'] as string | undefined);
      seenAuth.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (connections === 1) {
        res.end('id: 1\ndata: {"seq":1}\n\nid: 2\ndata: {"seq":2}\n\n');
      } else {
        res.write('id: 3\ndata: {"seq":3}\n\n');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const received: unknown[] = [];
    const fwd = new EventForwarder({ getPort: () => port, token: 'tok', send: (e) => received.push(e), initialRetryMs: 10 });
    fwd.start();
    const t0 = Date.now();
    while (received.length < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    fwd.stop();
    expect(received).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    expect(seenHeaders.slice(0, 2)).toEqual([undefined, '2']);
    expect(seenAuth.every((a) => a === 'Bearer tok')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run apps/desktop`
Expected: FAIL with "Failed to load url ../src/main/supervisor.ts" (and similar for the other files).

- [ ] **Step 4: Implement the Electron-free modules**

```ts
// apps/desktop/src/main/backoff.ts
export const DEFAULT_RESTART_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

export function restartDelay(consecutiveCrashes: number, schedule: readonly number[] = DEFAULT_RESTART_SCHEDULE_MS): number {
  return schedule[Math.min(consecutiveCrashes, schedule.length - 1)] ?? 16000;
}
```

```ts
// apps/desktop/src/main/supervisor.ts
import type { OrchestratorState, SystemState } from '@aik/contracts';
import { EventEmitter } from 'node:events';
import { restartDelay } from './backoff.ts';

export interface ChildLike {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface SupervisorOptions {
  fork: () => ChildLike;
  initMessage: () => Record<string, unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  schedule?: readonly number[];
  crashWindowMs?: number;
  maxCrashes?: number;
}

type Fatal = NonNullable<SystemState['fatal']>;

/** Keeps exactly one orchestrator utility process alive (spec §6.10). */
export class OrchestratorSupervisor extends EventEmitter {
  state: OrchestratorState = 'stopped';
  port: number | null = null;
  fatal: Fatal | null = null;
  child: ChildLike | null = null;

  private readonly opts: Required<Omit<SupervisorOptions, 'schedule'>> & { schedule?: readonly number[] };
  private crashes: number[] = [];
  private consecutive = 0;
  private stopping = false;

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = {
      now: () => Date.now(),
      setTimer: (fn, ms) => void setTimeout(fn, ms),
      crashWindowMs: 5 * 60_000,
      maxCrashes: 5,
      ...opts,
    };
  }

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  restart(): void {
    this.crashes = [];
    this.consecutive = 0;
    this.fatal = null;
    this.stopping = false;
    if (this.child === null) this.spawn();
  }

  async stop(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, timeoutMs);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'shutdown' });
    });
    this.setState('stopped');
  }

  private spawn(): void {
    this.port = null;
    this.setState('starting');
    const child = this.opts.fork();
    this.child = child;
    child.on('message', (m) => this.onMessage(child, m));
    child.on('exit', (code) => this.onExit(child, code));
    child.postMessage(this.opts.initMessage());
  }

  private onMessage(child: ChildLike, message: unknown): void {
    if (child !== this.child) return;
    const m = message as { type?: string; port?: number; kind?: Fatal['kind']; message?: string };
    if (m.type === 'ready' && typeof m.port === 'number') {
      this.port = m.port;
      this.consecutive = 0;
      this.setState('ready');
      this.emit('ready', m.port);
    } else if (m.type === 'fatal' && m.kind) {
      this.fatal = { kind: m.kind, message: m.message ?? '' };
      this.setState('fatal');
      this.emit('fatal', this.fatal);
    }
  }

  private onExit(child: ChildLike, code: number): void {
    if (child !== this.child) return;
    this.child = null;
    this.port = null;
    this.emit('down', code);
    if (this.stopping || this.state === 'fatal') return;
    const t = this.opts.now();
    this.crashes = [...this.crashes.filter((c) => t - c < this.opts.crashWindowMs), t];
    if (this.crashes.length > this.opts.maxCrashes) {
      this.setState('crash-loop');
      this.emit('crash-loop');
      return;
    }
    const delay = restartDelay(this.consecutive, this.opts.schedule);
    this.consecutive += 1;
    this.setState('restarting');
    this.opts.setTimer(() => {
      if (!this.stopping && this.child === null && this.state === 'restarting') this.spawn();
    }, delay);
  }

  private setState(state: OrchestratorState): void {
    this.state = state;
    this.emit('state', state);
  }
}
```

```ts
// apps/desktop/src/main/ui-path.ts
import path from 'node:path';

/** CSP for the packaged renderer: scripts only from the bundle (spec §21 S11). */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function resolveUiFile(uiRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'app:' || url.host !== 'ui') return null;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (rel === '' || rel === '/') rel = '/index.html';
  const root = path.resolve(uiRoot);
  const full = path.resolve(root, `.${rel}`);
  return full.startsWith(root + path.sep) ? full : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function contentTypeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
```

```ts
// apps/desktop/src/main/links.ts
const ALLOWED_HOSTS = new Set(['github.com', 'docs.github.com', 'opencode.ai', 'ollama.com', 'openrouter.ai', 'developers.cloudflare.com']);

/** External links open in the OS browser only for allowlisted HTTPS hosts without credentials. */
export function isAllowedExternal(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}
```

```ts
// apps/desktop/src/main/events-forwarder.ts
import { createSseParser } from '@aik/contracts';

export interface ForwarderOptions {
  getPort: () => number | null;
  token: string;
  send: (event: unknown) => void;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

/** Consumes the orchestrator SSE stream in the main process and forwards events to the renderer. */
export class EventForwarder {
  private readonly opts: ForwarderOptions;
  private lastEventId: string | null = null;
  private controller: AbortController | null = null;
  private running = false;

  constructor(opts: ForwarderOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
  }

  private async loop(): Promise<void> {
    const initial = this.opts.initialRetryMs ?? 500;
    let retry = initial;
    while (this.running) {
      const port = this.opts.getPort();
      if (port !== null) {
        this.controller = new AbortController();
        try {
          const res = await fetch(`http://127.0.0.1:${port}/events`, {
            headers: { authorization: `Bearer ${this.opts.token}`, ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}) },
            signal: this.controller.signal,
          });
          if (res.ok && res.body) {
            retry = initial;
            const parse = createSseParser((m) => {
              if (m.id !== null) this.lastEventId = m.id;
              try {
                this.opts.send(JSON.parse(m.data));
              } catch {
                /* ignore malformed event */
              }
            });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parse(decoder.decode(value, { stream: true }));
            }
          }
        } catch {
          /* connection dropped or aborted — reconnect below */
        }
      }
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, retry));
      retry = Math.min(retry * 2, this.opts.maxRetryMs ?? 8000);
    }
  }
}
```

```ts
// apps/desktop/src/main/paths.ts
import { APP_ID } from '@aik/contracts';
import path from 'node:path';

export function resolveDataDir(env: NodeJS.ProcessEnv, fallbackAppData: string): string {
  if (env.AIK_DATA_DIR) return path.resolve(env.AIK_DATA_DIR);
  return path.join(env.LOCALAPPDATA ?? fallbackAppData, APP_ID);
}

export interface DesktopPaths {
  dataDir: string;
  db: string;
  backups: string;
  logs: string;
  electronUserData: string;
}

export function desktopPaths(dataDir: string): DesktopPaths {
  return {
    dataDir,
    db: path.join(dataDir, 'app.db'),
    backups: path.join(dataDir, 'backups'),
    logs: path.join(dataDir, 'logs'),
    electronUserData: path.join(dataDir, 'electron'),
  };
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run apps/desktop`
Expected: PASS (supervisor 8, ui-path 4, links 8, events-forwarder 1).

- [ ] **Step 6: Implement the Electron modules, preload and entry**

```ts
// apps/desktop/src/main/protocol.ts
import { protocol } from 'electron';
import fs from 'node:fs';
import { CSP, contentTypeFor, resolveUiFile } from './ui-path.ts';

export const APP_SCHEME = { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } };

export function registerAppProtocol(uiRoot: string): void {
  protocol.handle('app', async (request) => {
    const file = resolveUiFile(uiRoot, request.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    return new Response(await fs.promises.readFile(file), {
      headers: { 'content-type': contentTypeFor(file), 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
    });
  });
}
```

```ts
// apps/desktop/src/main/window.ts
import { APP_NAME } from '@aik/contracts';
import { BrowserWindow, shell } from 'electron';
import { isAllowedExternal } from './links.ts';

export function createMainWindow(opts: { preload: string; url: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedExternal(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  void win.loadURL(opts.url);
  return win;
}
```

```ts
// apps/desktop/src/main/bridge.ts
import type { BridgeResponse, SystemState } from '@aik/contracts';
import { listBackups, restoreBackup } from '@aik/db/backup';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import type { DesktopPaths } from './paths.ts';
import type { OrchestratorSupervisor } from './supervisor.ts';

const BridgeRequest = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().max(2000).regex(/^\/(?!events\b)[A-Za-z0-9/_\-.~%?=&,+]*$/),
  body: z.unknown().optional(),
  idempotencyKey: z.uuid().optional(),
});

export interface BridgeDeps {
  supervisor: OrchestratorSupervisor;
  token: string;
  paths: DesktopPaths;
  isTrustedSender: (url: string) => boolean;
}

const unavailable = (message: string): BridgeResponse => ({
  status: 503,
  body: { error: { code: 'DEPENDENCY_UNAVAILABLE', message, retryable: true } },
});

function assertTrusted(event: IpcMainInvokeEvent, deps: BridgeDeps): void {
  const url = event.senderFrame?.url ?? '';
  if (!deps.isTrustedSender(url)) throw new Error('Untrusted IPC sender');
}

/** The renderer's only door to the orchestrator. The token never leaves the main process (plan deviation 1). */
export function registerBridge(deps: BridgeDeps): void {
  ipcMain.handle('aik:request', async (event, raw: unknown): Promise<BridgeResponse> => {
    assertTrusted(event, deps);
    const req = BridgeRequest.parse(raw);
    const port = deps.supervisor.port;
    if (port === null) return unavailable('The orchestrator is not running');
    try {
      const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${deps.token}`,
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : {}),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    } catch {
      return unavailable('The orchestrator did not respond');
    }
  });

  ipcMain.handle('aik:pick-directory', async (event): Promise<string | null> => {
    assertTrusted(event, deps);
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('aik:system-state', (event): SystemState => {
    assertTrusted(event, deps);
    return { state: deps.supervisor.state, fatal: deps.supervisor.fatal };
  });

  ipcMain.handle('aik:restore-latest-backup', (event) => {
    assertTrusted(event, deps);
    if (deps.supervisor.state !== 'fatal' || deps.supervisor.fatal?.kind !== 'database_corrupt') {
      return { ok: false as const, reason: 'Restore is only available when the database is corrupt' };
    }
    const latest = listBackups(deps.paths.backups).at(-1);
    if (!latest) return { ok: false as const, reason: 'No backups were found' };
    restoreBackup(latest, deps.paths.db);
    deps.supervisor.restart();
    return { ok: true as const, restoredFrom: path.basename(latest) };
  });

  ipcMain.handle('aik:restart-orchestrator', (event) => {
    assertTrusted(event, deps);
    deps.supervisor.restart();
  });
}
```

```ts
// apps/desktop/src/main/index.ts
import { app, BrowserWindow, protocol, session, utilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerBridge } from './bridge.ts';
import { EventForwarder } from './events-forwarder.ts';
import { desktopPaths, resolveDataDir } from './paths.ts';
import { APP_SCHEME, registerAppProtocol } from './protocol.ts';
import { OrchestratorSupervisor, type ChildLike } from './supervisor.ts';
import { createMainWindow } from './window.ts';

protocol.registerSchemesAsPrivileged([APP_SCHEME]);

const isE2E = process.env.AIK_E2E === '1';
const paths = desktopPaths(resolveDataDir(process.env, app.getPath('appData')));
fs.mkdirSync(paths.logs, { recursive: true });
app.setPath('userData', paths.electronUserData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function forkOrchestrator(): ChildLike {
  const proc = utilityProcess.fork(path.join(__dirname, 'orchestrator.cjs'), [], { serviceName: 'AI Kanban Orchestrator', stdio: 'pipe' });
  const out = fs.createWriteStream(path.join(paths.logs, 'orchestrator-stdio.log'), { flags: 'a' });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const child: ChildLike = {
    get pid() {
      return proc.pid;
    },
    postMessage: (m: unknown) => proc.postMessage(m),
    kill: () => proc.kill(),
    on(event: 'message' | 'exit', listener: (arg: never) => void) {
      proc.on(event as 'exit', listener as (code: number) => void);
      return child;
    },
  };
  return child;
}

function main(): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const devUrl = process.env.AIK_UI_DEV_URL ?? null;
  let win: BrowserWindow | null = null;

  const supervisor = new OrchestratorSupervisor({
    fork: forkOrchestrator,
    initMessage: () => ({
      type: 'init',
      token,
      dataDir: paths.dataDir,
      migrationsFolder: path.join(__dirname, 'migrations'),
      versions: { app: app.getVersion(), electron: process.versions.electron },
      logLevel: process.env.AIK_LOG_LEVEL ?? 'info',
    }),
    schedule: isE2E && process.env.AIK_TEST_FAST_RESTART === '1' ? [50, 50, 50, 50, 50] : undefined,
  });
  const forwarder = new EventForwarder({ getPort: () => supervisor.port, token, send: (e) => win?.webContents.send('aik:event', e) });
  supervisor.on('state', () => win?.webContents.send('aik:system', { state: supervisor.state, fatal: supervisor.fatal }));

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    forwarder.stop();
    void supervisor.stop().finally(() => app.quit());
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerAppProtocol(path.join(__dirname, 'ui'));
    registerBridge({
      supervisor,
      token,
      paths,
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
    });
    supervisor.start();
    forwarder.start();
    win = createMainWindow({ preload: path.join(__dirname, 'preload.cjs'), url: devUrl ?? 'app://ui/index.html' });
    if (isE2E) (globalThis as Record<string, unknown>).__aik = { supervisor, dataDir: paths.dataDir, token };
  });
}
```

```ts
// apps/desktop/src/preload/index.ts
import type { AikWindowApi, BridgeResponse, EventEnvelope, HttpMethod, SystemState } from '@aik/contracts';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api: AikWindowApi = {
  request: (method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string) =>
    ipcRenderer.invoke('aik:request', { method, path, body, idempotencyKey }) as Promise<BridgeResponse>,
  pickDirectory: () => ipcRenderer.invoke('aik:pick-directory') as Promise<string | null>,
  systemState: () => ipcRenderer.invoke('aik:system-state') as Promise<SystemState>,
  restoreLatestBackup: () => ipcRenderer.invoke('aik:restore-latest-backup'),
  restartOrchestrator: () => ipcRenderer.invoke('aik:restart-orchestrator') as Promise<void>,
  events: {
    subscribe(listener) {
      const handler = (_e: IpcRendererEvent, value: EventEnvelope) => listener(value);
      ipcRenderer.on('aik:event', handler);
      return () => {
        ipcRenderer.removeListener('aik:event', handler);
      };
    },
  },
  system: {
    subscribe(listener) {
      const handler = (_e: IpcRendererEvent, value: SystemState) => listener(value);
      ipcRenderer.on('aik:system', handler);
      return () => {
        ipcRenderer.removeListener('aik:system', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 7: Write the build and dev scripts**

```js
// apps/desktop/scripts/build.mjs — bundles main, preload and orchestrator; copies migrations and the UI.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const out = path.join(root, 'apps', 'desktop', 'dist');
const withUi = !process.argv.includes('--no-ui');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'warning', sourcemap: true };
await build({ ...common, entryPoints: [path.join(root, 'apps/desktop/src/main/index.ts')], outfile: path.join(out, 'main.cjs'), external: ['electron'] });
await build({ ...common, entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')], outfile: path.join(out, 'preload.cjs'), external: ['electron'], sourcemap: false });
await build({ ...common, entryPoints: [path.join(root, 'apps/orchestrator/src/main.ts')], outfile: path.join(out, 'orchestrator.cjs'), external: ['better-sqlite3', 'pino'] });

fs.cpSync(path.join(root, 'packages/db/migrations'), path.join(out, 'migrations'), { recursive: true });
if (withUi) {
  const ui = path.join(root, 'apps/ui/dist');
  if (!fs.existsSync(path.join(ui, 'index.html'))) throw new Error('apps/ui/dist is missing — run `npm run build -w @aik/ui` first');
  fs.cpSync(ui, path.join(out, 'ui'), { recursive: true });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'ai-kanban', productName: 'AI Kanban', version: pkg.version, main: 'main.cjs' }, null, 2));
console.log(`desktop build written to ${path.relative(root, out)}${withUi ? '' : ' (without UI)'}`);
```

```js
// apps/desktop/scripts/dev.mjs — Vite dev server + shell build + Electron pointed at the dev server.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shellBuild = spawnSync(process.execPath, [path.join(root, 'apps/desktop/scripts/build.mjs'), '--no-ui'], { stdio: 'inherit' });
if (shellBuild.status !== 0) process.exit(shellBuild.status ?? 1);
const vite = spawn(npx, ['vite', '--port', '5173', '--strictPort'], { cwd: path.join(root, 'apps/ui'), stdio: 'inherit', shell: true });
const electron = spawn(npx, ['electron', path.join(root, 'apps/desktop/dist')], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, AIK_UI_DEV_URL: 'http://localhost:5173/' },
});
electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
```

- [ ] **Step 8: Build the shell and run the static checks**

Run: `npm run build:shell && npm run lint && npm run typecheck && npx vitest run apps/desktop`
Expected:
- `apps/desktop/dist/{main.cjs,preload.cjs,orchestrator.cjs,migrations/,package.json}` exist.
- There are no lint or type errors and the unit tests pass.

The renderer isn't built until Task 14, so launching the app is verified there.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop package.json package-lock.json
git commit -m "feat(desktop): hardened Electron shell, orchestrator supervisor, app:// protocol and token-free IPC bridge"
```


---

### Task 14: Renderer shell, dashboard, settings and the E2E harness (FND-2/3 verification, screens #2, #3, #20)

**Files:**
- Create: `apps/ui/package.json`, `apps/ui/vite.config.ts`, `apps/ui/index.html`
- Create: `apps/ui/src/main.tsx`, `router.tsx`, `index.css`, `vite-env.d.ts`
- Create: `apps/ui/src/lib/api.ts`, `events.ts`, `theme.ts`
- Create: `apps/ui/src/components/ui/button.tsx`, `badge.tsx`, `dialog.tsx`, `field.tsx`, `toast.tsx`
- Create: `apps/ui/src/routes/root.tsx`, `dashboard.tsx`, `settings.tsx`
- Create: `e2e/playwright.config.ts`, `e2e/fixtures.ts`, `e2e/tests/dashboard.spec.ts`
- Modify: root `package.json` (the `e2e` script and the `@playwright/test` devDependency)

**Interfaces:**
- Consumes:
  - `window.api: AikWindowApi` (Task 13);
  - `ProjectDTO`, `EventEnvelope`, `SystemState` and `ApiError` (Task 2);
  - `/health` and `/projects` (Tasks 8 and 10).
- Produces:
  - `api.get/post/patch<T>(path, body?)`, which throws `ApiRequestError { status; code; failedGuards; reason }`;
  - `useOutboxEvents(onEvent)` (de-duplicated by `seq`) and `useSystemState()`;
  - `Button`, `Badge`, `Dialog`, `TextField`, `TextArea`, `ToastProvider` and `useToast(): (message: string, tone?: 'info' | 'error') => void`;
  - `router` (hash history);
  - test ids `app-ready`, `project-list`, `project-error`, `system-failure`;
  - E2E helpers `launchApp(dataDir, env?)`, `waitReady(page)`, `apiCall(page, method, path, body?)`, `aik(app)` (main-process test hook), and re-exported `makeTempDir`/`makeTempRepo`.

- [ ] **Step 1: Create the UI package and install**

```json
// apps/ui/package.json
{
  "name": "@aik/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite" },
  "dependencies": {
    "@aik/contracts": "0.0.0",
    "@aik/workflow": "0.0.0",
    "@atlaskit/pragmatic-drag-and-drop": "4.0.0",
    "@tanstack/react-router": "1.170.45",
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "tailwindcss": "4.3.3",
    "vite": "8.3.4"
  }
}
```

Run: `npm install`, then `npm install -E -D @playwright/test@1.64.1`
Add the root script: `"e2e": "playwright test -c e2e/playwright.config.ts"`

```ts
// apps/ui/vite.config.ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { port: 5173, strictPort: true },
});
```

```html
<!-- apps/ui/index.html -->
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Kanban</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```css
/* apps/ui/src/index.css */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

html, body, #root { height: 100%; }
```

```ts
// apps/ui/src/vite-env.d.ts
/// <reference types="vite/client" />
import type { AikWindowApi } from '@aik/contracts';

declare global {
  interface Window {
    api: AikWindowApi;
  }
}
export {};
```

- [ ] **Step 2: Write the client libraries**

```ts
// apps/ui/src/lib/api.ts
import type { ApiError, FailedGuard, HttpMethod } from '@aik/contracts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly failedGuards: FailedGuard[];

  constructor(status: number, body: unknown) {
    const err = (body as ApiError | null)?.error;
    super(err?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = err?.code ?? 'INTERNAL';
    this.failedGuards = err?.failedGuards ?? [];
  }

  /** Human-readable explanation, preferring the guard reasons. */
  get reason(): string {
    return this.failedGuards.length > 0 ? this.failedGuards.map((g) => g.reason).join('; ') : this.message;
  }
}

async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const key = method === 'GET' ? undefined : crypto.randomUUID();
  const res = await window.api.request(method, path, body, key);
  if (res.status >= 400) throw new ApiRequestError(res.status, res.body);
  return res.body as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
};
```

```ts
// apps/ui/src/lib/events.ts
import type { EventEnvelope, SystemState } from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';

/** Subscribes to orchestrator events; drops anything already seen (by seq). */
export function useOutboxEvents(onEvent: (event: EventEnvelope) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const lastSeq = useRef(0);
  useEffect(
    () =>
      window.api.events.subscribe((e) => {
        if (e.topic !== 'system.resync' && e.seq <= lastSeq.current) return;
        lastSeq.current = Math.max(lastSeq.current, e.seq);
        handler.current(e);
      }),
    [],
  );
}

export function useSystemState(): SystemState {
  const [state, setState] = useState<SystemState>({ state: 'starting', fatal: null });
  useEffect(() => {
    let alive = true;
    void window.api.systemState().then((s) => {
      if (alive) setState(s);
    });
    const off = window.api.system.subscribe(setState);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
```

```ts
// apps/ui/src/lib/theme.ts
const KEY = 'aik.theme';
export type Theme = 'light' | 'dark';

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: theme still applies for this session */
  }
}
```

- [ ] **Step 3: Write the UI primitives**

```tsx
// apps/ui/src/components/ui/button.tsx
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500',
  secondary: 'bg-zinc-200 text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  ghost: 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
```

```tsx
// apps/ui/src/components/ui/badge.tsx
import type { HTMLAttributes } from 'react';

type Tone = 'default' | 'muted' | 'warn' | 'danger' | 'ok';
const TONES: Record<Tone, string> = {
  default: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200',
  muted: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  danger: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
};

export function Badge({ tone = 'default', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`} {...props} />;
}
```

```tsx
// apps/ui/src/components/ui/dialog.tsx
import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className="m-auto rounded-lg bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="w-[32rem] max-w-[90vw] p-5">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
```

```tsx
// apps/ui/src/components/ui/field.tsx
import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const INPUT = 'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950';

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <input id={id} className={INPUT} {...props} />
    </div>
  );
}

export function TextArea({ label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <textarea id={id} className={`${INPUT} min-h-20`} {...props} />
    </div>
  );
}
```

```tsx
// apps/ui/src/components/ui/toast.tsx
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'info' | 'error';
type Toast = { id: number; message: string; tone: Tone };
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-md px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-800 text-white'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
```

- [ ] **Step 4: Write the routes, router and entry**

```tsx
// apps/ui/src/routes/root.tsx
import type { SystemState } from '@aik/contracts';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { ToastProvider } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

export interface Health {
  status: string;
  versions: { app: string; electron: string | null; node: string; opencode: string | null };
  components: { db: string };
  dataDir: string;
}

function SystemFailure({ system }: { system: SystemState }) {
  const [note, setNote] = useState<string | null>(null);
  const corrupt = system.state === 'fatal' && system.fatal?.kind === 'database_corrupt';
  return (
    <div data-testid="system-failure" role="alert" className="m-4 rounded-md border border-red-400 bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100">
      {system.state === 'crash-loop' ? (
        <>
          <p className="font-semibold">The orchestrator keeps crashing.</p>
          <p className="text-sm">See logs\orchestrator.log and logs\orchestrator-stdio.log in the data folder.</p>
          <Button className="mt-2" onClick={() => void window.api.restartOrchestrator()}>Try again</Button>
        </>
      ) : (
        <>
          <p className="font-semibold">The orchestrator could not start.</p>
          <p className="text-sm">{system.fatal?.message}</p>
          {corrupt && (
            <Button
              className="mt-2"
              variant="primary"
              onClick={async () => {
                const r = await window.api.restoreLatestBackup();
                setNote(r.ok ? `Restored ${r.restoredFrom}` : r.reason);
              }}
            >
              Restore latest backup
            </Button>
          )}
          {note && <p className="mt-2 text-sm">{note}</p>}
        </>
      )}
    </div>
  );
}

export function RootLayout() {
  const system = useSystemState();
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    if (system.state !== 'ready') return;
    let alive = true;
    api.get<Health>('/health').then(
      (h) => alive && setHealth(h),
      () => alive && setHealth(null),
    );
    return () => {
      alive = false;
    };
  }, [system.state]);

  return (
    <ToastProvider>
      <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <span className="font-semibold">AI Kanban</span>
          <nav className="flex gap-3 text-sm">
            <Link to="/" className="hover:underline">Projects</Link>
            <Link to="/settings" className="hover:underline">Settings</Link>
          </nav>
          <span className="ml-auto text-xs text-zinc-500" aria-label="Orchestrator status">orchestrator: {system.state}</span>
        </header>
        {(system.state === 'fatal' || system.state === 'crash-loop') && <SystemFailure system={system} />}
        {health && <div data-testid="app-ready" hidden />}
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
```

```tsx
// apps/ui/src/routes/dashboard.tsx
import type { ProjectDTO } from '@aik/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

function CreateProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/projects', { name, key, repoPath });
      setName('');
      setKey('');
      setRepoPath('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add a local repository" className="mt-6 flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-semibold">Add a local repository</h2>
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <TextField label="Key" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="INV" required />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField label="Repository folder" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} required />
        </div>
        <Button onClick={async () => {
          const dir = await window.api.pickDirectory();
          if (dir) setRepoPath(dir);
        }}>
          Browse…
        </Button>
      </div>
      {error && <p role="alert" data-testid="project-error" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy} className="self-start">Add project</Button>
    </form>
  );
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const system = useSystemState();
  const load = useCallback(async () => {
    try {
      setProjects(await api.get<ProjectDTO[]>('/projects'));
    } catch {
      setProjects([]);
    }
  }, []);
  useEffect(() => {
    if (system.state === 'ready') void load();
  }, [system.state, load]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <ul data-testid="project-list" className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            <span className="font-medium">{`${p.key} · ${p.name}`}</span>
            <span className="text-sm text-zinc-500">{p.baseBranch}</span>
            {p.status === 'unavailable' && <Badge tone="warn">unavailable</Badge>}
          </li>
        ))}
      </ul>
      <CreateProjectForm onCreated={load} />
    </div>
  );
}
```

```tsx
// apps/ui/src/routes/settings.tsx
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { applyTheme, loadTheme, type Theme } from '../lib/theme.ts';
import type { Health } from './root.tsx';

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    void api.get<Health>('/health').then(setHealth, () => setHealth(null));
  }, []);
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="mt-4">
        <h2 className="font-semibold">Theme</h2>
        <Button
          className="mt-2"
          onClick={() => {
            const next: Theme = theme === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            setTheme(next);
          }}
        >
          Switch to {theme === 'dark' ? 'light' : 'dark'} theme
        </Button>
      </section>
      <section className="mt-6" aria-label="About">
        <h2 className="font-semibold">About</h2>
        <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-1 text-sm">
          <dt>Data folder</dt>
          <dd data-testid="data-dir">{health?.dataDir ?? '…'}</dd>
          <dt>App version</dt>
          <dd>{health?.versions.app ?? '…'}</dd>
          <dt>Electron</dt>
          <dd>{health?.versions.electron ?? '…'}</dd>
          <dt>OpenCode</dt>
          <dd>{health?.versions.opencode ?? 'not installed'}</dd>
        </dl>
      </section>
    </div>
  );
}
```

```tsx
// apps/ui/src/router.tsx
import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { DashboardPage } from './routes/dashboard.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

export const router = createRouter({ routeTree: rootRoute.addChildren([dashboardRoute, settingsRoute]), history: createHashHistory() });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

```tsx
// apps/ui/src/main.tsx
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { applyTheme, loadTheme } from './lib/theme.ts';
import { router } from './router.tsx';

applyTheme(loadTheme());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 5: Write the E2E harness and the failing dashboard tests**

```ts
// e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
});
```

```ts
// e2e/fixtures.ts
import type { AikWindowApi, BridgeResponse } from '@aik/contracts';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

export { makeTempDir, makeTempRepo } from '../apps/orchestrator/test/helpers/temp.ts';
export const repoRoot = path.resolve(import.meta.dirname, '..');
export const distDir = path.join(repoRoot, 'apps', 'desktop', 'dist');

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

export async function launchApp(dataDir: string, env: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({
    args: [distDir],
    env: { ...(process.env as Record<string, string>), AIK_DATA_DIR: dataDir, AIK_E2E: '1', ...env },
  });
  const page = await app.firstWindow();
  return { app, page };
}

export async function waitReady(page: Page): Promise<void> {
  await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 30_000 });
}

/** Calls the orchestrator through the same bridge the UI uses. */
export function apiCall<T = unknown>(page: Page, method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown): Promise<BridgeResponse & { body: T }> {
  return page.evaluate(
    ([m, url, b]) => {
      const api = (window as unknown as { api: AikWindowApi }).api;
      return api.request(m, url, b, m === 'GET' ? undefined : crypto.randomUUID());
    },
    [method, p, body] as const,
  ) as Promise<BridgeResponse & { body: T }>;
}

/** Main-process test hook, present only when AIK_E2E=1. */
export function aik<T>(app: ElectronApplication, fn: (h: { supervisor: { state: string; port: number | null; child: { pid: number | undefined } | null }; token: string; dataDir: string }) => T): Promise<T> {
  return app.evaluate((_electron, f) => {
    const hook = (globalThis as unknown as { __aik: Parameters<typeof fn>[0] }).__aik;
    return new Function('h', `return (${f})(h)`)(hook) as T;
  }, fn.toString());
}
```

```ts
// e2e/tests/dashboard.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('registers a local repository from the dashboard', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Name').fill('Inventory');
  await page.getByLabel('Key').fill('INV');
  await page.getByLabel('Repository folder').fill(makeTempRepo());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-list')).toContainText('INV · Inventory');
  await expect(page.getByTestId('project-list')).toContainText('main');
  await app.close();
});

test('explains why a folder cannot be registered', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await page.getByLabel('Name').fill('Nope');
  await page.getByLabel('Key').fill('NOPE');
  await page.getByLabel('Repository folder').fill(makeTempDir());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-error')).toContainText('not inside a git repository');
  await app.close();
});

test('settings shows the data folder and versions', async () => {
  const dataDir = makeTempDir();
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('data-dir')).toHaveText(dataDir);
  await app.close();
});
```

- [ ] **Step 6: Build, then run the E2E tests**

Run: `npm run build && npm run e2e -- dashboard.spec.ts`
Expected:
- The build writes `apps/desktop/dist/ui/index.html`.
- 3 E2E tests PASS.
- If `waitReady` times out, open `<dataDir>\logs\orchestrator.log` and `orchestrator-stdio.log` to find the cause.

- [ ] **Step 7: Run the static checks and commit**

Run: `npm run check:pins && npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add apps/ui e2e package.json package-lock.json
git commit -m "feat(ui): renderer shell with dashboard, settings, system-failure screen and Electron E2E harness"
```

---

### Task 15: Kanban board (FND-11)

**Files:**
- Create: `apps/ui/src/lib/stories.ts`, `apps/ui/src/lib/transitions.ts`
- Create: `apps/ui/src/components/kanban/board.tsx`, `column.tsx`, `card.tsx`, `move-menu.tsx`, `create-story-dialog.tsx`, `request-changes-dialog.tsx`, `confirm-dialog.tsx`
- Create: `apps/ui/src/routes/board.tsx`
- Modify: `apps/ui/src/router.tsx` (add the board route), `apps/ui/src/routes/dashboard.tsx` (link projects to the board)
- Test: `e2e/tests/board.spec.ts`

**Interfaces:**
- Consumes:
  - `dragVerdict` and `DragVerdict` (Task 3);
  - the stories API and `TransitionRequest` (Task 11);
  - `api`, `ApiRequestError`, `useOutboxEvents`, `useSystemState`, `useToast`, `Dialog`, `Button`, `Badge` and the field components (Task 14).
- Produces:
  - `useStories(projectId, query): { stories; error; refetch }`;
  - `performMove(story, to, ui: MoveUi): Promise<{ ok: true } | { ok: false; reason: string }>`, where `MoveUi = { confirm(message): Promise<boolean>; askFindings(): Promise<string | null>; beforeRequest(): void }`;
  - test ids `board`, `column-<STATUS>`, `card-<KEY>`, and `new-story`.

- [ ] **Step 1: Write the failing E2E tests**

```ts
// e2e/tests/board.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
let dataDir: string;
let projectId: number;

async function openBoard(page: Page) {
  await page.getByRole('link', { name: /^INV · Inventory$/ }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}

test.beforeEach(async () => {
  dataDir = makeTempDir();
  launched = await launchApp(dataDir);
  await waitReady(launched.page);
  const created = await apiCall<{ id: number }>(launched.page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  projectId = created.body.id;
  // Re-mount the dashboard via in-app routing (window hardening blocks page navigations such as reload).
  await launched.page.getByRole('link', { name: 'Settings' }).click();
  await launched.page.getByRole('link', { name: 'Projects' }).click();
  await openBoard(launched.page);
});
test.afterEach(async () => {
  await launched.app.close();
});

test('creates a story from the board', async () => {
  const { page } = launched;
  await page.getByTestId('new-story').click();
  await page.getByLabel('Title').fill('Inventory module');
  await page.getByLabel('Acceptance criteria (one per line)').fill('Create works\nSearch works');
  await page.getByRole('button', { name: 'Create story' }).click();
  await expect(page.getByTestId('column-NEW').getByTestId('card-INV-1')).toContainText('Inventory module');
});

test('refuses to drag a story into DONE and explains why', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Drag me' });
  await expect(page.getByTestId('card-INV-1')).toBeVisible();
  await page.getByTestId('card-INV-1').dragTo(page.getByTestId('column-DONE'));
  await expect(page.getByRole('status')).toContainText('Stories become DONE only after an approved, verified merge');
  await expect(page.getByTestId('column-NEW')).toContainText('INV-1');
});

test('cancels a story with the keyboard Move to… menu', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Cancel me' });
  const card = page.getByTestId('card-INV-1');
  await card.getByRole('button', { name: 'Move to…' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'CANCELLED' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cancel story' }).click();
  await page.getByTestId('column-CANCELLED').getByRole('button', { name: 'Show' }).click();
  await expect(page.getByTestId('column-CANCELLED')).toContainText('INV-1');
});

test('disabled moves explain themselves', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Read-only moves' });
  await page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' }).click();
  await expect(page.getByRole('menuitem', { name: /IN_PROGRESS/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /IN_PROGRESS/ })).toHaveAttribute('title', 'Only the orchestrator moves stories from NEW to IN_PROGRESS');
});

test('search narrows the board', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Alpha feature' });
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Beta feature' });
  await page.getByLabel('Search stories').fill('alpha');
  await expect(page.getByTestId('card-INV-1')).toBeVisible();
  await expect(page.getByTestId('card-INV-2')).toHaveCount(0);
});

test('stories persist across restarts', async () => {
  await apiCall(launched.page, 'POST', `/projects/${projectId}/stories`, { title: 'Durable' });
  await launched.app.close();
  launched = await launchApp(dataDir);
  await waitReady(launched.page);
  await openBoard(launched.page);
  await expect(launched.page.getByTestId('card-INV-1')).toContainText('Durable');
});

test('renders 200 stories', async () => {
  const { page } = launched;
  for (let i = 0; i < 200; i++) await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: `Story ${i}` });
  await expect(page.locator('[data-testid^="card-"]')).toHaveCount(200, { timeout: 10_000 });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build && npm run e2e -- board.spec.ts`
Expected: FAIL. The project link doesn't exist yet, so `openBoard` times out.

- [ ] **Step 3: Implement the hooks and the move logic**

```ts
// apps/ui/src/lib/stories.ts
import type { StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from './api.ts';
import { useOutboxEvents, useSystemState } from './events.ts';

export interface StoryQuery {
  q: string;
  label: string;
  sort: 'rank' | 'priority' | 'updated' | 'created';
}

export function useStories(projectId: number, query: StoryQuery) {
  const [stories, setStories] = useState<StoryDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams({ sort: query.sort, ...(query.q ? { q: query.q } : {}), ...(query.label ? { label: query.label } : {}) }).toString();

  const refetch = useCallback(async () => {
    try {
      setStories(await api.get<StoryDTO[]>(`/projects/${projectId}/stories?${qs}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.reason : String(e));
    }
  }, [projectId, qs]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOutboxEvents((e) => {
    if (!e.topic.startsWith('story.') && e.topic !== 'system.resync') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refetch(), 100);
  });

  // After an orchestrator restart, our statusVersions may be stale: refetch (Review Focus #5).
  const system = useSystemState();
  useEffect(() => {
    if (system.state === 'ready') void refetch();
  }, [system.state, refetch]);

  return { stories, error, refetch };
}
```

```ts
// apps/ui/src/lib/transitions.ts
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dragVerdict, type DragStory } from '@aik/workflow';
import { ApiRequestError, api } from './api.ts';

/** Adapts the API DTO (blocked.from) to the state machine's drag input (blockedFrom). */
export const toDragStory = (s: StoryDTO): DragStory => ({
  status: s.status,
  blockedFrom: s.blocked?.from ?? null,
  planningStatus: s.planningStatus,
  activePlanVersion: s.activePlanVersion,
});

export interface MoveUi {
  confirm(message: string): Promise<boolean>;
  askFindings(): Promise<string | null>;
  beforeRequest(): void;
}

/** Turns a board move into the single human event it may request. Empty reason = the user backed out. */
export async function performMove(story: StoryDTO, to: StoryStatus, ui: MoveUi): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = dragVerdict(toDragStory(story), to);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  const body: Record<string, unknown> = { event: verdict.target.event, expectedVersion: story.statusVersion };
  switch (verdict.target.event) {
    case 'cancel':
      if (!(await ui.confirm(`Cancel ${story.key}? Active work stops; the worktree is kept.`))) return { ok: false, reason: '' };
      break;
    case 'approve_plan':
      body.planVersion = story.activePlanVersion;
      break;
    case 'recover':
      body.target = verdict.target.recoverTarget;
      break;
    case 'request_changes': {
      const text = await ui.askFindings();
      if (!text) return { ok: false, reason: '' };
      body.sha = story.candidateSha;
      body.findings = [{ text }];
      break;
    }
  }
  ui.beforeRequest();
  try {
    await api.post(`/stories/${story.id}/transitions`, body);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { ok: false, reason: e.code === 'VERSION_CONFLICT' ? 'The story changed in the meantime; the board was refreshed' : e.reason };
  }
}
```

- [ ] **Step 4: Implement the Kanban components**

```tsx
// apps/ui/src/components/kanban/confirm-dialog.tsx
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';

export function ConfirmDialog({ message, onAnswer }: { message: string | null; onAnswer: (ok: boolean) => void }) {
  return (
    <Dialog open={message !== null} title="Please confirm" onClose={() => onAnswer(false)}>
      <p className="text-sm">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(false)}>Keep story</Button>
        <Button variant="danger" onClick={() => onAnswer(true)}>Cancel story</Button>
      </div>
    </Dialog>
  );
}
```

```tsx
// apps/ui/src/components/kanban/request-changes-dialog.tsx
import { useState } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextArea } from '../ui/field.tsx';

export function RequestChangesDialog({ open, onAnswer }: { open: boolean; onAnswer: (text: string | null) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} title="Request changes" onClose={() => onAnswer(null)}>
      <TextArea label="What must change?" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(null)}>Back</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => { onAnswer(text.trim()); setText(''); }}>Send to rework</Button>
      </div>
    </Dialog>
  );
}
```

```tsx
// apps/ui/src/components/kanban/create-story-dialog.tsx
import type { Priority } from '@aik/contracts';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextArea, TextField } from '../ui/field.tsx';

export function CreateStoryDialog({ open, projectId, onClose, onCreated }: { open: boolean; projectId: number; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [labels, setLabels] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/projects/${projectId}/stories`, {
        title,
        description,
        priority,
        acceptanceCriteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean),
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setTitle('');
      setDescription('');
      setCriteria('');
      setLabels('');
      setError(null);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    }
  };

  return (
    <Dialog open={open} title="New story" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextArea label="Acceptance criteria (one per line)" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        <TextField label="Labels (comma separated)" value={labels} onChange={(e) => setLabels(e.target.value)} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary">Create story</Button>
        </div>
      </form>
    </Dialog>
  );
}
```

```tsx
// apps/ui/src/components/kanban/move-menu.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { dragVerdict } from '@aik/workflow';
import { useState } from 'react';
import { toDragStory } from '../../lib/transitions.ts';
import { Button } from '../ui/button.tsx';

export function MoveMenu({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mt-2">
      <Button variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Move to…</Button>
      {open && (
        <ul role="menu" aria-label={`Move ${story.key} to`} className="absolute z-10 mt-1 w-56 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {STORY_STATUS.filter((s) => s !== story.status).map((to) => {
            const v = dragVerdict(toDragStory(story), to);
            return (
              <li key={to} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!v.allowed}
                  title={v.allowed ? undefined : v.reason}
                  onClick={() => {
                    setOpen(false);
                    onMove(story, to);
                  }}
                  className="w-full rounded px-2 py-1 text-left text-sm enabled:hover:bg-zinc-100 disabled:opacity-40 dark:enabled:hover:bg-zinc-800"
                >
                  {to}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

```tsx
// apps/ui/src/components/kanban/card.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef } from 'react';
import { Badge } from '../ui/badge.tsx';
import { MoveMenu } from './move-menu.tsx';

export function Card({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ storyId: story.id }) });
  }, [story.id]);
  return (
    <div ref={ref} data-testid={`card-${story.key}`} tabIndex={0} aria-label={`${story.key} ${story.title}`} className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-zinc-500">{story.key}</span>
        <Badge>{story.priority}</Badge>
      </div>
      <p className="mt-1 text-sm font-medium">{story.title}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {story.labels.map((l) => <Badge key={l} tone="muted">{l}</Badge>)}
        {story.hold && <Badge tone="warn">on hold</Badge>}
        {story.blocked && <Badge tone="danger" title={story.blocked.hint}>blocked: {story.blocked.reason}</Badge>}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
        <span>attempt {story.attempts.used}/{story.attempts.max}</span>
        {story.activeRun && <span>{story.activeRun.model}</span>}
      </div>
      <MoveMenu story={story} onMove={onMove} />
    </div>
  );
}
```

```tsx
// apps/ui/src/components/kanban/column.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';
import { Card } from './card.tsx';

export function Column(props: {
  status: StoryStatus;
  stories: StoryDTO[];
  collapsed: boolean;
  collapsible: boolean;
  highlight: boolean;
  onToggle: () => void;
  onDropStory: (storyId: number, to: StoryStatus) => void;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
}) {
  const { status, stories, collapsed, collapsible, highlight, onToggle, onDropStory, onMove } = props;
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ status }),
      canDrop: ({ source }) => typeof source.data.storyId === 'number',
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        onDropStory(source.data.storyId as number, status);
      },
    });
  }, [status, onDropStory]);
  return (
    <section
      ref={ref}
      aria-label={`${status} column`}
      data-testid={`column-${status}`}
      className={`flex w-72 shrink-0 flex-col rounded-lg border p-2 ${over ? 'border-indigo-500' : highlight ? 'border-indigo-300 dark:border-indigo-800' : 'border-zinc-200 dark:border-zinc-800'}`}
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wide">{status}</h2>
        <span className="text-xs text-zinc-500">{stories.length}</span>
        {collapsible && (
          <button type="button" className="ml-auto text-xs underline" aria-expanded={!collapsed} onClick={onToggle}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </header>
      {!collapsed && (
        <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto">
          {stories.map((s) => (
            <li key={s.id}>
              <Card story={s} onMove={onMove} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

```tsx
// apps/ui/src/components/kanban/board.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dragVerdict } from '@aik/workflow';
import { useCallback, useEffect, useState } from 'react';
import { performMove, toDragStory } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { Column } from './column.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { RequestChangesDialog } from './request-changes-dialog.tsx';

export function Board({ stories, onChanged }: { stories: StoryDTO[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [pending, setPending] = useState<Record<number, StoryStatus>>({});
  const [dragging, setDragging] = useState<StoryDTO | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ DONE: true, CANCELLED: true });
  const [confirm, setConfirm] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const [changes, setChanges] = useState<{ resolve: (text: string | null) => void } | null>(null);

  useEffect(
    () =>
      monitorForElements({
        onDragStart: ({ source }) => setDragging(stories.find((s) => s.id === source.data.storyId) ?? null),
        onDrop: () => setDragging(null),
      }),
    [stories],
  );

  const move = useCallback(
    async (story: StoryDTO, to: StoryStatus) => {
      const result = await performMove(story, to, {
        confirm: (message) => new Promise((resolve) => setConfirm({ message, resolve })),
        askFindings: () => new Promise((resolve) => setChanges({ resolve })),
        beforeRequest: () => setPending((p) => ({ ...p, [story.id]: to })),
      });
      setPending((p) => {
        const next = { ...p };
        delete next[story.id];
        return next;
      });
      if (!result.ok && result.reason) toast(result.reason, 'error');
      await onChanged();
    },
    [onChanged, toast],
  );

  const onDropStory = useCallback(
    (storyId: number, to: StoryStatus) => {
      const story = stories.find((s) => s.id === storyId);
      if (story) void move(story, to);
    },
    [stories, move],
  );

  const byStatus = Object.fromEntries(STORY_STATUS.map((s) => [s, [] as StoryDTO[]])) as Record<StoryStatus, StoryDTO[]>;
  for (const s of stories) byStatus[pending[s.id] ?? s.status].push(s);

  return (
    <div data-testid="board" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {STORY_STATUS.map((status) => (
        <Column
          key={status}
          status={status}
          stories={byStatus[status]}
          collapsible={status === 'DONE' || status === 'CANCELLED'}
          collapsed={collapsed[status] === true}
          highlight={dragging !== null && dragVerdict(toDragStory(dragging), status).allowed}
          onToggle={() => setCollapsed((c) => ({ ...c, [status]: !c[status] }))}
          onDropStory={onDropStory}
          onMove={(story, to) => void move(story, to)}
        />
      ))}
      <ConfirmDialog
        message={confirm?.message ?? null}
        onAnswer={(ok) => {
          confirm?.resolve(ok);
          setConfirm(null);
        }}
      />
      <RequestChangesDialog
        open={changes !== null}
        onAnswer={(text) => {
          changes?.resolve(text);
          setChanges(null);
        }}
      />
    </div>
  );
}
```

```tsx
// apps/ui/src/routes/board.tsx
import type { ProjectDTO } from '@aik/contracts';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Board } from '../components/kanban/board.tsx';
import { CreateStoryDialog } from '../components/kanban/create-story-dialog.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { useStories, type StoryQuery } from '../lib/stories.ts';

export function BoardPage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const id = Number(projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [query, setQuery] = useState<StoryQuery>({ q: '', label: '', sort: 'rank' });
  const [creating, setCreating] = useState(false);
  const { stories, error, refetch } = useStories(id, query);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">{project ? `${project.key} · ${project.name}` : 'Board'}</h1>
        <input aria-label="Search stories" placeholder="Search…" value={query.q} onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        <input aria-label="Filter by label" placeholder="Label" value={query.label} onChange={(e) => setQuery((q) => ({ ...q, label: e.target.value }))} className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        <select aria-label="Sort stories" value={query.sort} onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as StoryQuery['sort'] }))} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950">
          <option value="rank">Board order</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
        </select>
        <Button data-testid="new-story" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>New story</Button>
      </div>
      {error && <p role="alert" className="px-4 py-2 text-sm text-red-600">{error}</p>}
      <Board stories={stories} onChanged={refetch} />
      <CreateStoryDialog open={creating} projectId={id} onClose={() => setCreating(false)} onCreated={() => void refetch()} />
    </div>
  );
}
```

Update the router and dashboard:

```tsx
// apps/ui/src/router.tsx (replace the file)
import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { BoardPage } from './routes/board.tsx';
import { DashboardPage } from './routes/dashboard.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId', component: BoardPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, settingsRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

In `apps/ui/src/routes/dashboard.tsx`, add `import { Link } from '@tanstack/react-router';`, then replace:

```tsx
            <span className="font-medium">{`${p.key} · ${p.name}`}</span>
```

with:

```tsx
            <Link to="/projects/$projectId" params={{ projectId: String(p.id) }} className="font-medium hover:underline">
              {`${p.key} · ${p.name}`}
            </Link>
```

- [ ] **Step 5: Build and run the board E2E tests**

Run: `npm run build && npm run e2e -- board.spec.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Run the static checks, the whole E2E suite, and commit**

Run: `npm run lint && npm run typecheck && npm run e2e`
Expected: no errors; the dashboard and board specs pass.

```bash
git add apps/ui e2e
git commit -m "feat(ui): Kanban board with guarded drag-and-drop, keyboard Move to…, filters and live updates"
```

---

### Task 16: Security and lifecycle E2E suite, CI end-to-end (FND-2/3/8 acceptance)

**Files:**
- Test: `e2e/tests/security.spec.ts`, `e2e/tests/lifecycle.spec.ts`
- Modify: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: the E2E helpers (Task 14), the `__aik` main-process test hook (Task 13), and the orchestrator crash hook (Task 12).
- Produces: E2E coverage for FND-2 AC 1–4, FND-3 AC 1–3, FND-5 AC 5 (restore), FND-8 AC 1 (reconnect) and Review Focus #5. CI then runs build plus E2E on `windows-latest`.

- [ ] **Step 1: Write the security tests**

```ts
// e2e/tests/security.spec.ts
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import electronPath from 'electron';
import { aik, apiCall, distDir, launchApp, makeTempDir, waitReady } from '../fixtures.ts';

const rawGet = (port: number, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });

test('the renderer has no Node access and never sees the API token', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const token = await aik(app, (h) => h.token);
  const probe = await page.evaluate((t) => {
    const g = globalThis as unknown as Record<string, unknown>;
    return {
      require: typeof g.require,
      process: typeof g.process,
      api: typeof (window as unknown as { api: { request: unknown } }).api.request,
      leaked: [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie].some((s) => s.includes(t)),
    };
  }, token);
  expect(probe).toEqual({ require: 'undefined', process: 'undefined', api: 'function', leaked: false });
  await app.close();
});

test('CSP blocks injected inline scripts', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const pwned = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = 1';
    document.body.appendChild(s);
    return (window as unknown as { __pwned?: number }).__pwned ?? null;
  });
  expect(pwned).toBeNull();
  await app.close();
});

test('navigation away and window.open are blocked', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const before = page.url();
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(1000);
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true);
  expect(app.windows()).toHaveLength(1);
  await app.close();
});

test('the API rejects missing tokens, foreign hosts and foreign origins', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const { port, token } = await aik(app, (h) => ({ port: h.supervisor.port as number, token: h.token }));
  expect(await rawGet(port, {})).toBe(401);
  expect(await rawGet(port, { authorization: `Bearer ${token}`, host: 'evil.example' })).toBe(403);
  expect(await rawGet(port, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).toBe(403);
  expect(await rawGet(port, { authorization: `Bearer ${token}` })).toBe(200);
  await app.close();
});

test('a second instance exits and leaves the first one working', async () => {
  const dataDir = makeTempDir();
  const first = await launchApp(dataDir);
  await waitReady(first.page);
  const second = spawn(electronPath as unknown as string, [distDir], { env: { ...process.env, AIK_DATA_DIR: dataDir, AIK_E2E: '1' }, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve) => second.once('exit', resolve));
  expect(code).toBe(0);
  expect((await apiCall(first.page, 'GET', '/health')).status).toBe(200);
  await first.app.close();
});
```

- [ ] **Step 2: Write the lifecycle tests**

```ts
// e2e/tests/lifecycle.spec.ts
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { aik, apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('board recovers after orchestrator restart', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_TEST_FAST_RESTART: '1' });
  await waitReady(page);
  const project = await apiCall<{ id: number }>(page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  const story = await apiCall<{ id: number; statusVersion: number }>(page, 'POST', `/projects/${project.body.id}/stories`, { title: 'Survives a crash' });
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'INV · Inventory' }).click();
  await expect(page.getByTestId('card-INV-1')).toBeVisible();

  const oldPid = await aik(app, (h) => h.supervisor.child?.pid as number);
  process.kill(oldPid);
  await expect.poll(() => aik(app, (h) => (h.supervisor.state === 'ready' ? h.supervisor.child?.pid : null)), { timeout: 20_000 }).not.toBeNull();
  expect(await aik(app, (h) => h.supervisor.child?.pid)).not.toBe(oldPid);

  // Changes made after the restart reach the board through the reconnected event stream…
  await apiCall(page, 'POST', `/stories/${story.body.id}/transitions`, { event: 'hold', expectedVersion: story.body.statusVersion });
  await expect(page.getByTestId('card-INV-1')).toContainText('on hold');
  await apiCall(page, 'POST', `/projects/${project.body.id}/stories`, { title: 'Created after restart' });
  await expect(page.getByTestId('card-INV-2')).toBeVisible();
  // …and the UI's statusVersion is fresh, so a move succeeds without a reload.
  await page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'CANCELLED' }).click();
  await page.getByRole('button', { name: 'Cancel story' }).click();
  await expect(page.getByTestId('column-CANCELLED')).toContainText('1');
  await app.close();
});

test('quitting leaves no orphaned orchestrator', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const pid = await aik(app, (h) => h.supervisor.child?.pid as number);
  await app.close();
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
});

test('a crash loop shows the failure screen', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_TEST_CRASH_ORCHESTRATOR: '1', AIK_TEST_FAST_RESTART: '1' });
  await expect(page.getByTestId('system-failure')).toContainText('keeps crashing', { timeout: 20_000 });
  await app.close();
});

test('a corrupt database can be restored from the latest backup', async () => {
  const dataDir = makeTempDir();
  let run = await launchApp(dataDir);
  await waitReady(run.page);
  await apiCall(run.page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  await run.app.close();
  run = await launchApp(dataDir); // second start writes a backup of the healthy database
  await waitReady(run.page);
  await run.app.close();

  fs.writeFileSync(path.join(dataDir, 'app.db'), 'corrupted '.repeat(1000));
  run = await launchApp(dataDir);
  await expect(run.page.getByTestId('system-failure')).toContainText('could not start');
  await run.page.getByRole('button', { name: 'Restore latest backup' }).click();
  await waitReady(run.page);
  await expect(run.page.getByTestId('project-list')).toContainText('INV · Inventory');
  await run.app.close();
});
```

- [ ] **Step 3: Run the new suites**

Run: `npm run build && npm run e2e -- security.spec.ts lifecycle.spec.ts`
Expected: 9 tests PASS.

- [ ] **Step 4: Extend CI with the build and E2E, and document the commands**

Replace the steps list in `.github/workflows/ci.yml` with:

```yaml
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24.17.0
          cache: npm
      - run: npm ci
      - run: npm run check:pins
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm run e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: |
            e2e/playwright-report
            e2e/test-results
```

Add these rows to the README's command table:

```markdown
| `npm run build` | build the renderer and bundle the Electron shell into `apps/desktop/dist` |
| `npm start` | run the built app (data in `%LOCALAPPDATA%\AiKanban`; override with `AIK_DATA_DIR`) |
| `npm run dev` | Vite dev server + Electron (renderer hot reload) |
| `npm run e2e` | Playwright Electron end-to-end tests (run `npm run build` first) |
```

- [ ] **Step 5: Run everything once more, then commit**

Run: `npm run check:pins && npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: all green.

```bash
git add e2e .github/workflows/ci.yml README.md
git commit -m "test(e2e): renderer security, API hardening, single instance, crash recovery, restore; CI runs E2E"
```

---

## Phase 1 exit check (spec §25.2)

All of the following must be true. Record the evidence (command output) in the final commit message, or in a short note under `docs/superpowers/plans/`:
- [ ] The app launches (`npm start`) and shows the dashboard.
- [ ] Stories survive restarts (`board.spec.ts › stories persist across restarts`).
- [ ] Illegal drags are rejected with a reason (`board.spec.ts › refuses to drag a story into DONE…`).
- [ ] SSE replay works (`sse.test.ts` and `lifecycle.spec.ts › board recovers after orchestrator restart`).
- [ ] API security tests pass (`api-security.test.ts`, `security.spec.ts`).
