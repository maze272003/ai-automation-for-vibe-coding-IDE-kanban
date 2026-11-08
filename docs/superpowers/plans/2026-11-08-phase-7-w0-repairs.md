# Phase 7 · W0 Repairs Implementation Plan

_Plan review log:_ round 1 (GLM 5.3) NOT SATISFIED — 2 MAJOR (Task 9 e2e had no mock planner → explicit recipe + skip guard; Task 1 purge missed run-less `model_usage` rows → widened delete + test) and 5 MINOR (probe-row success, reuse `repoPath`, `skillDirFor` anchor/row shape, Windows `.cmd` probe, all seven shortcuts asserted) — all applied. Round 2 NOT SATISFIED — 2 MAJOR (Task 10 corrective turn could finish on turn 1's stale `idle` → turn baseline for completion/text/activity + test; Task 13/14 `failedGuards` must be `{ guard, reason }` objects) and 2 MINOR (Task 4 price computed once via `recordUsage` first; Task 10 activity diff seeded from baseline) — all applied. **Round 3: SATISFIED** (0 blocking, 0 major); its 2 minors applied (`OpenCodeMessageLike.id` added to Task 10's files; Task 15 names `ROLE_DEFAULT_SKILLS`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what is already built honest and reachable: record cost per agent run, give projects a settings page, make plans approvable and never invented, make safety rails fail closed, deliver skill content to agents, wire Diagnostics and shortcuts, and fix four correctness bugs (spec W0-1 … W0-7, plus B7).

**Architecture:** Mostly orchestrator changes (Fastify routes, agents, verify runner, drizzle/SQLite), one hand-written migration (0004), pure UI logic modules tested with vitest, and UI pages/components covered by Playwright. All story status changes stay inside `WorkflowService`; no new workflow transitions are added in W0.

**Tech Stack:** TypeScript 6.0.3, Node, Fastify 5.12.7, drizzle-orm 0.45.4 + better-sqlite3 13.0.3, zod 4.6.7, React 19.3.1 + @tanstack/react-router 1.170.45, vitest 5.0.5 (node environment only), Playwright (`npm run e2e`).

**Spec:** `docs/superpowers/specs/2026-11-08-phase-7-autopilot-visibility-design.md` (rev 11) — sections §4, §6 W0-1…W0-7, B7, §7, §8, §12.

## Global Constraints

- Done-gate per task and at the end: `npm run check:pins && npm run lint && npm run typecheck && npm test`. Until spec Q-U1 is answered, exactly these pre-existing failures are tolerated and these files must not be edited: `packages/contracts/test/agent-team.test.ts`, `apps/orchestrator/test/spawn-streaming.test.ts`, `apps/orchestrator/test/agent-env.test.ts`. Narrow equivalents that must be clean:
  - `npx tsc -p tsconfig.json | grep -vE "agent-team\.test|spawn-streaming\.test|agent-env\.test"` → no output
  - `npx eslint . --ignore-pattern apps/orchestrator/test/spawn-streaming.test.ts` → clean
  - `npx vitest run --exclude packages/contracts/test/agent-team.test.ts --exclude apps/orchestrator/test/spawn-streaming.test.ts --exclude apps/orchestrator/test/agent-env.test.ts` → all pass
  - `npm run check:pins` → "All dependency versions are exact."
- Dependencies: exact versions only (`npm install -E`). W0 adds **no** new dependency.
- Tests never touch a real repository: use `makeTempDir`/`makeTempRepo` from `apps/orchestrator/test/helpers/temp.ts` (they assert paths are under the OS temp dir).
- Never log or persist secrets; persisted process/provider output goes through the redactor (`deps.redact` / `redactor`).
- Story status changes only through `WorkflowService` (test helpers may use `forceStory` for arrange steps).
- Never import `spikes/` (reading spike output files for facts is fine).
- Migrations: hand-written SQL + snapshot + `_journal.json` entry; statements separated by `--> statement-breakpoint`; the new entry's `when` must be strictly greater than `1794077538524` (0003) — use `max(1794077538525, Date.now())` at implementation time; `idx` = 4; snapshot `prevId` = `fef5520a-820c-4fce-99e5-96666049ba96`. Never run the interactive `npm run db:generate` to create it; afterwards `npm run db:generate` must report no changes (a prompt means the snapshot is wrong: abort and fix it).
- Append-only tables (`IMMUTABLE_TABLES` = `story_events, reviews, review_findings, review_ac_results, verification_checks, merge_approvals`) are only inserted into.
- Lint: `@typescript-eslint/consistent-type-imports` is an error — use `import type`, and never write `import('…')` type annotations.
- Commits: conventional commits with scope, lowercase imperative subject (e.g. `feat(orchestrator): record run cost`), ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on a branch `feat/phase-7-w0` (never commit on `main`).
- UI tests run in vitest's `node` environment (no jsdom / Testing Library): put UI logic in `apps/ui/src/lib/*.ts` and test it with vitest by mocking `../src/lib/api.ts` (`vi.hoisted` + `vi.mock`, pattern in `apps/ui/test/files-api.test.ts`); cover pages and components with Playwright specs in `e2e/tests/`.

## Review Focus

1. **A run that dies before or during the session still records usage honestly.** No session (runtime unreachable) → `cost_source='unknown'`, tokens NULL, no crash; interrupted/timed-out runs record whatever the session reported. Tests: Task 3 (`recordUsage` with `usage: null`) and Task 4 (interrupted + timed-out runs write exactly one `model_usage` row).
2. **Provider not in the catalog must never be called "free".** `ensureModelProfile` creates unknown providers with `costClass:'local'`; pricing must use the catalog, not that DB default. Test: Task 2 (`priceUsage` for an unknown provider → `unknown`).
3. **Approving a merge whose protected-path list changed under the user** (new candidate committed while the dialog was open). Expected: rejected, nothing written. Test: Task 13 (ack for the old list after a newer `candidate_committed` → 409, no approval row).
4. **Planner that keeps answering prose.** Expected: exactly one corrective turn per run, then `planning_failed`; never a fabricated plan; usage of both turns recorded once. Tests: Task 10.
5. **A settings save that the server rejects for one nested field** (e.g. `checks[1].command` empty). Expected: the error appears next to that field; nothing else is lost. Test: Task 6 (`issuesByField` maps `['settings','checks',1,'command']`).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `packages/db/migrations/0004_usage_cost_run_skills.sql`, `meta/0004_snapshot.json`, `meta/_journal.json` | Migration 0004 | 1 |
| `packages/db/src/schema.ts` | `modelUsage` rebuild shape, new `runSkills` table | 1 |
| `packages/db/test/helpers/migrations-upto.ts` (new) | Build a migrations folder truncated at a tag | 1 |
| `packages/db/test/migrate-0004.test.ts`, `packages/db/test/journal.test.ts` (new) | Upgrade + journal invariants | 1 |
| `apps/orchestrator/src/projects/purge-repo.ts` | Delete `run_skills` before `agent_runs` | 1 |
| `packages/contracts/src/usage.ts` (new), `packages/contracts/src/index.ts` | `SessionUsage`, `CostSource`, `extractSessionUsage` | 2 |
| `packages/providers/src/pricing.ts` (new), `packages/providers/src/index.ts` | `findCatalogModel`, `priceUsage` | 2 |
| `packages/contracts/src/events.ts` | topic `usage.recorded` | 3 |
| `apps/orchestrator/src/metrics/record-usage.ts` (new) | `recordUsage` | 3 |
| `apps/orchestrator/src/agents/runtime.ts` | usage/sessionId/model/timedOut on output; `continueSession` | 4, 10 |
| `apps/orchestrator/src/agents/finish-run.ts` (new) | `finishRun` — one place that ends a run | 4 |
| `apps/orchestrator/src/agents/{planner,implementer,reviewer}.ts` | use `finishRun`; skills recording; planner corrective turn | 4, 10, 15 |
| `apps/orchestrator/src/metrics/usage-service.ts`, `api/routes/metrics.ts` | cost totals, `storyId` filter, by-day/by-project, probe route | 5 |
| `packages/contracts/src/stories.ts`, `apps/orchestrator/src/stories/dto.ts` | `StoryDTO.costUsd`, `costComplete` | 5 |
| `apps/ui/src/components/UsageDashboard.tsx`, `apps/ui/src/lib/usage-format.ts` (new), `apps/ui/src/routes/usage.tsx`, `apps/ui/src/routes/settings.tsx`, `apps/desktop/src/main/opencode-server.ts` | dollar UI, project picker, probe usage | 5 |
| `apps/ui/src/lib/api.ts`, `apps/ui/src/lib/project-settings.ts` (new) | `ApiRequestError.details`, settings form logic | 6 |
| `apps/orchestrator/src/security/vulnerability.ts`, `api/routes/projects.ts` | `probeScanner`, scanner endpoint | 6, 12 |
| `apps/ui/src/routes/project-settings.tsx` (new), `router.tsx`, `routes/board.tsx`, `components/ui/field.tsx` | settings page, banner, gear | 7 |
| `apps/orchestrator/src/stories/service.ts` (`getDetails`, `approve_merge`) | plan meta/previous plan; protected-path ack | 8, 13 |
| `apps/ui/src/lib/plan-view.ts` (new), `lib/transitions.ts`, `components/kanban/terminal-modal.tsx`, `card.tsx` | plan view, approve button | 9 |
| `apps/orchestrator/src/agents/plan-parse.ts` (new) | strict plan parsing | 10 |
| `apps/orchestrator/src/agents/planning-budget.ts` (new), `runner.ts`, `stuck-stories.ts` | B7 per-round budget | 11 |
| `apps/orchestrator/src/verify/runner.ts`, `packages/contracts/src/hints.ts` | fail-closed scan, blocked detail | 12 |
| `apps/orchestrator/src/stories/protected-ack.ts` (new), `packages/contracts/src/stories.ts` | protected-path acknowledgement | 13 |
| `apps/ui/src/lib/merge-ack.ts` (new) | ack UI logic | 14 |
| `apps/orchestrator/src/skills/bridge.ts`, `apps/orchestrator/src/skills/run-skills.ts` (new) | recommendations + inline bodies + recording | 15 |
| `apps/orchestrator/src/api/routes/maintenance.ts`, `app.ts`, `test/helpers/app.ts` | diagnostics routes + wiring | 16 |
| `apps/ui/src/routes/root.tsx`, `router.tsx`, `components/shell/sidebar.tsx`, `routes/settings.tsx` | diagnostics route, shortcuts mount | 17 |
| `apps/ui/src/lib/run-log-view.ts` (new), `terminal-modal.tsx`, `maintenance/retention.ts`, `agents/review-status.ts` (new), `runner.ts`, `stuck-stories.ts` | W0-7 fixes | 18, 19, 20 |

---

### Task 1: Migration 0004 — `model_usage` rebuild and `run_skills`

**Files:**
- Create: `packages/db/migrations/0004_usage_cost_run_skills.sql`, `packages/db/migrations/meta/0004_snapshot.json`, `packages/db/test/helpers/migrations-upto.ts`, `packages/db/test/migrate-0004.test.ts`, `packages/db/test/journal.test.ts`
- Modify: `packages/db/migrations/meta/_journal.json`, `packages/db/src/schema.ts:369-379` (`modelUsage`) + new `runSkills`, `packages/db/test/open.test.ts:22` (table count 29 → 30), `apps/orchestrator/src/projects/purge-repo.ts:49` (+ its test `apps/orchestrator/test/project-delete.test.ts`)

**Interfaces:**
- Produces (schema.ts):
  - `modelUsage` columns: `id`, `agentRunId` (nullable FK agent_runs), `modelProfileId` (**nullable** FK model_profiles), `httpStatus` (**nullable**), `inputTokens`, `outputTokens`, `latencyMs` (**nullable**), `fallbackFrom`, `createdAt` (NOT NULL), **new:** `runtime text NOT NULL DEFAULT 'opencode'`, `modelSlug text`, `effort text`, `costUsd real`, `cachedInputTokens integer`, `durationMs integer`, `costSource text NOT NULL DEFAULT 'unknown'` (enum `reported|estimated|free|unknown`), `storyId integer` (FK user_stories, nullable), `projectId integer` (FK projects, nullable). Indexes: `mu_profile_time_idx(model_profile_id, created_at)`, `mu_project_time_idx(project_id, created_at)`, `mu_story_idx(story_id)`.
  - `runSkills` table `run_skills`: `id integer pk autoincrement`, `agentRunId integer NOT NULL` FK agent_runs, `skillId text NOT NULL` (vault `skills.id`), `skillName text NOT NULL`, `contentSha256 text` (sha256 hex of the delivered body), `createdAt` ts NOT NULL; `uniqueIndex('rs_run_skill_uq').on(agentRunId, skillId)`.
  - `migrationsUpTo(tag: string, dir: string): string` — copies every `NNNN_*.sql` up to and including `tag` plus a `meta/_journal.json` containing only those entries into `dir`; returns `dir`.

- [ ] **Step 1: Write failing tests**

`packages/db/test/journal.test.ts`:
```ts
it('journal entries have strictly increasing when, contiguous idx, and a .sql per tag', () => {
  const j = readJournal(); // JSON.parse of migrations/meta/_journal.json
  j.entries.forEach((e, i) => { expect(e.idx).toBe(i); if (i > 0) expect(e.when).toBeGreaterThan(j.entries[i - 1].when); expect(fs.existsSync(path.join(MIGRATIONS, `${e.tag}.sql`))).toBe(true); });
  const sqlFiles = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4));
  expect(sqlFiles.sort()).toEqual(j.entries.map((e) => e.tag).sort());
});
```
`packages/db/test/migrate-0004.test.ts` (temp dir via `fs.mkdtempSync(os.tmpdir())`):
```ts
it('upgrades a populated 0003 database without losing model_usage rows', () => {
  const old = migrationsUpTo('0003_office_rooms', tmp('m3'));
  // open with `old`, seed provider, model_profile, project, story, agent_run, and 2 model_usage rows
  // (one with agent_run_id, one without), close; reopen same file with full MIGRATIONS
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, httpStatus: 200, latencyMs: 50, runtime: 'opencode', costSource: 'unknown', costUsd: null, storyId: null, projectId: null });
  expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(indexNames('model_usage')).toEqual(expect.arrayContaining(['mu_profile_time_idx', 'mu_project_time_idx', 'mu_story_idx']));
});
it('accepts a per-run usage row with null profile, http status and latency', () => { /* insert {agentRunId, modelProfileId: null, httpStatus: null, latencyMs: null, costUsd: 0.0123, costSource: 'reported'} → reads back equal */ });
it('run_skills rejects a duplicate (run, skill) pair', () => { /* second insert throws /UNIQUE/ */ });
it('creates a backup before upgrading', () => { /* backupsDir has ≥1 file after reopen */ });
```
`open.test.ts`: change `toHaveLength(29)` to `toHaveLength(30)`. `project-delete.test.ts`: add a `run_skills` row to the seeded project and assert it is gone after purge; add a `model_usage` row with `agent_run_id NULL` and `project_id` = the purged project (and one with `story_id` set, `agent_run_id NULL`) and assert both are gone and the purge succeeds (no FK error).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/db/test/migrate-0004.test.ts packages/db/test/journal.test.ts packages/db/test/open.test.ts`
Expected: FAIL (no 0004, 29 tables, missing columns).

- [ ] **Step 3: Write migration SQL, schema, snapshot, journal, helper, purge change**

SQL order: `CREATE TABLE model_usage_new (...)` with the full column list above → `INSERT INTO model_usage_new (id, agent_run_id, model_profile_id, http_status, input_tokens, output_tokens, latency_ms, fallback_from, created_at) SELECT id, agent_run_id, model_profile_id, http_status, input_tokens, output_tokens, latency_ms, fallback_from, created_at FROM model_usage` → `DROP TABLE model_usage` → `ALTER TABLE model_usage_new RENAME TO model_usage` → the three `CREATE INDEX` → `CREATE TABLE run_skills (...)` → `CREATE UNIQUE INDEX rs_run_skill_uq ...`. `open.ts` enables `foreign_keys` before `migrate()`; the rebuild is safe because nothing references `model_usage` (assert with `foreign_key_check` in the test). Snapshot: copy `0003_snapshot.json`, apply the column/table changes, new random `id`, `prevId` = 0003's id. Purge (`purge-repo.ts:50`): delete `run_skills` where `agent_run_id IN (runs of the project)` before deleting `agent_runs`; widen the `model_usage` delete to `project_id = <projectId> OR story_id IN (<stories of the project>) OR agent_run_id IN (<runs of the project>)` — the new FKs on `story_id`/`project_id` would otherwise abort the purge for run-less rows (`foreign_keys = ON`, `open.ts:69`).

- [ ] **Step 4: Verify**

Run: `npx vitest run packages/db apps/orchestrator/test/project-delete.test.ts` → PASS. Run `npx drizzle-kit check --config packages/db/drizzle.config.ts` → OK. Run `npm run db:generate` → "No schema changes".

- [ ] **Step 5: Commit** — `feat(db): rebuild model_usage for run cost and add run_skills (0004)`

---

### Task 2: Usage extraction and pricing (pure)

**Files:**
- Create: `packages/contracts/src/usage.ts`, `packages/contracts/test/usage.test.ts`, `packages/providers/src/pricing.ts`, `packages/providers/test/pricing.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/providers/src/index.ts` (re-export)

**Interfaces:**
- Produces (`@aik/contracts`):
  - `export const COST_SOURCE = ['reported', 'estimated', 'free', 'unknown'] as const; export type CostSource`
  - `export interface SessionUsage { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number; reportedCostUsd: number | null; assistantMessages: number }`
  - `extractSessionUsage(messages: readonly unknown[]): SessionUsage | null` — sums over items whose `type === 'assistant'`: `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `cost` (OpenCode message JSON, verified in `spikes/spk-1/out/*-messages.json`: `"cost": 0, "tokens": { "input", "output", "reasoning", "cache": { "read", "write" } }`). Non-numeric/missing fields count as 0. Returns `null` when there is no assistant message with a `tokens` object. `reportedCostUsd` = the sum when it is `> 0`, else `null` (OpenCode reports `0` both for free and for unpriced models, so `0` is not evidence).
- Produces (`@aik/providers`):
  - `findCatalogModel(providerId: string, modelId: string): { provider: CatalogProvider; model: CatalogModel | null } | null` — `findProvider(providerId)` then `models.find(m => m.id === modelId) ?? null`.
  - `priceUsage(input: { usage: SessionUsage | null; providerId: string | null; modelId: string | null }): { costUsd: number | null; costSource: CostSource }` — rules in this order:
    1. `usage?.reportedCostUsd != null` → `{ costUsd: reportedCostUsd, costSource: 'reported' }`
    2. catalog provider found and `costClass` ∈ {`local`, `free`} → `{ 0, 'free' }`
    3. `usage` present and catalog model has non-null `inputCost` and `outputCost` → `costUsd = inputTokens*inputCost/1e6 + (outputTokens + reasoningTokens)*outputCost/1e6` (cached input tokens are not priced — the estimate is a lower bound), `'estimated'`
    4. otherwise `{ null, 'unknown' }` (includes providers absent from the catalog — never "free").

- [ ] **Step 1: Write failing tests** (`usage.test.ts`, `pricing.test.ts`)
```ts
it('sums assistant tokens and ignores user/idle messages', () => {
  expect(extractSessionUsage([{ type: 'user' }, { type: 'assistant', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } } }, { type: 'assistant', cost: 0.02, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, { type: 'idle' }]))
    .toEqual({ inputTokens: 11, outputTokens: 6, reasoningTokens: 2, cachedInputTokens: 3, reportedCostUsd: 0.03, assistantMessages: 2 });
});
it('treats an all-zero cost as not reported', () => { expect(extractSessionUsage([{ type: 'assistant', cost: 0, tokens: { input: 1, output: 1 } }])?.reportedCostUsd).toBeNull(); });
it('returns null without assistant tokens', () => { expect(extractSessionUsage([{ type: 'assistant' }])).toBeNull(); expect(extractSessionUsage([])).toBeNull(); });
// pricing: pick a real paid catalog provider/model from CATALOG in the test (first provider with costClass 'paid_metered' and a model with both costs)
it('reported cost wins', () => { expect(priceUsage({ usage: u({ reportedCostUsd: 0.5 }), providerId: 'x', modelId: 'y' })).toEqual({ costUsd: 0.5, costSource: 'reported' }); });
it('local/free catalog providers cost 0', () => { /* providerId of a CATALOG entry with costClass 'local' → { costUsd: 0, costSource: 'free' } */ });
it('estimates from catalog prices (output + reasoning billed as output)', () => { /* 1_000_000 in, 500_000 out, 500_000 reasoning → inputCost + outputCost */ });
it('unknown provider is unknown, never free', () => { expect(priceUsage({ usage: u({}), providerId: 'not-in-catalog', modelId: 'm' })).toEqual({ costUsd: null, costSource: 'unknown' }); });
it('no usage and paid provider is unknown', () => { /* usage null → unknown */ });
```

- [ ] **Step 2: Run** `npx vitest run packages/contracts/test/usage.test.ts packages/providers/test/pricing.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three functions as specified.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): extract session usage and price it from the catalog`

---

### Task 3: `recordUsage` and the `usage.recorded` event

**Files:**
- Create: `apps/orchestrator/src/metrics/record-usage.ts`, `apps/orchestrator/test/record-usage.test.ts`
- Modify: `packages/contracts/src/events.ts` (append `'usage.recorded'` to `EVENT_TOPICS`)

**Interfaces:**
- Consumes: `SessionUsage`, `priceUsage` (Task 2); `appendOutbox(db, input, now)` from `apps/orchestrator/src/events/outbox.ts:12`.
- Produces:
```ts
export interface RecordUsageInput {
  agentRunId: number | null; storyId: number | null; projectId: number | null;
  runtime: 'opencode'; providerId: string | null; modelId: string | null; modelProfileId: number | null;
  usage: SessionUsage | null; durationMs: number | null;
}
export function recordUsage(db: AikDbOrTx, now: Date, input: RecordUsageInput): { id: number; costUsd: number | null; costSource: CostSource };
```
Writes one `model_usage` row (`modelSlug = providerId && modelId ? \`${providerId}/${modelId}\` : null`, `inputTokens/outputTokens` = usage values or NULL when usage is null, `outputTokens` excludes reasoning, `cachedInputTokens`, `costUsd`, `costSource`, `durationMs`, `httpStatus/latencyMs` NULL, `createdAt = now`), then `appendOutbox` topic `usage.recorded`, provenance `'system'`, `storyId`, data `{ usageId, agentRunId, costUsd, costSource }`.

- [ ] **Step 1: Failing tests** (`createTestDb`, `seedProject`, `seedStory`, `readOutbox`):
```ts
it('writes one priced row and emits usage.recorded', () => { /* reported 0.02 → row.costUsd 0.02, costSource 'reported', storyId/projectId set; outbox last topic 'usage.recorded' with data.costUsd 0.02 */ });
it('records an unknown-cost row when usage is null', () => { /* inputTokens null, outputTokens null, costSource 'unknown', costUsd null */ });
it('accepts a probe row without run, story or project', () => { /* agentRunId/storyId/projectId null → row exists, outbox storyId null */ });
```
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/record-usage.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(orchestrator): record model usage rows with cost`

---

### Task 4: Runtime reports usage/timeout; `finishRun` ends every run (W0-1, W0-7 timeouts)

**Files:**
- Create: `apps/orchestrator/src/agents/finish-run.ts`, `apps/orchestrator/test/finish-run.test.ts`
- Modify: `apps/orchestrator/src/agents/runtime.ts` (`RunOneShotOutput` :77, timeout return :308-312, final fetch :321), `apps/orchestrator/src/agents/planner.ts` (finish sites :227-231, :238-242, :286-290), `implementer.ts` (:201-205, :238-242, `failRun` :406-412), `reviewer.ts` (:291-295, `finishReview` :433-437, `failRun` :536-542), tests `agent-runtime.test.ts`, `planner.test.ts`, `implementer.test.ts`, `reviewer.test.ts`

**Interfaces:**
- Consumes: `recordUsage` (Task 3), `emitRunFinished` (`run-events.ts:47`), `extractSessionUsage` (Task 2).
- Produces:
  - `RunOneShotOutput` gains `timedOut?: boolean; sessionId?: string; model?: ModelRef; usage?: SessionUsage | null`. Whenever a session was created, `runOneShot` fetches `/api/session/{id}/message` once before returning on **every** path (success, failure, timeout, interrupt; best effort — a fetch error leaves `usage: null`) and sets `usage = extractSessionUsage(data)`, `sessionId`, `model` (the resolved `ModelRef`). The timeout path returns `{ ok: false, timedOut: true, error: 'The model did not finish within N seconds', … }`.
  - `export type RunFinalStatus = 'succeeded' | 'failed' | 'interrupted' | 'timed_out' | 'cancelled';`
  - `export function finishRun(db: AikDbOrTx, now: Date, input: { runId: number; status: RunFinalStatus; exitReason: string | null; usage: SessionUsage | null; model: ModelRef | null; durationMs: number | null }): void` — in this order: (1) `recordUsage` (story/project looked up from the run → story → project; `modelProfileId` from the run row; `providerId/modelId` from `input.model`), which returns `{ costUsd, costSource }`; (2) update `agent_runs` (`status`, `exitReason`, `endedAt = now`, `usage` JSON `{ requests: usage?.assistantMessages ?? 0, inTok, outTok, cachedInTok, costUsd, costSource }` using step 1's result — price computed once); (3) `emitRunFinished(db, now, runId, status, exitReason ?? undefined)`. Outbox order: `usage.recorded` then `run.finished`. Calling it twice for the same run is a no-op the second time (guard: skip when `endedAt` already set).
  - The `agent_runs.usage` `$type` in `schema.ts` widens to `{ requests: number; inTok: number; outTok: number; cachedInTok?: number; costUsd?: number | null; costSource?: CostSource }` (TS only; JSON column).
- Every one of the nine finish sites listed above is replaced by `finishRun`, with `status: result.timedOut ? 'timed_out' : …` where the site handles a failed runtime result. `stuck-stories.ts:344-345` (orphan → `interrupted`) also uses `finishRun` with `usage: null`.

- [ ] **Step 1: Failing tests**
  - `agent-runtime.test.ts` (extend the timeout test at :207): result has `timedOut: true`; a success test whose fake server returns assistant messages with tokens → `result.usage.inputTokens` equals the fixture sum and `result.sessionId` is set.
  - `finish-run.test.ts`: (a) succeeded run with usage → `agent_runs.status 'succeeded'`, `endedAt` set, `usage.costSource` set, exactly one `model_usage` row with `agentRunId`, `storyId`, `projectId`; outbox has `usage.recorded` then `run.finished`. (b) second call → still one row. (c) `usage: null` → row with `costSource 'unknown'`.
  - `planner.test.ts`: runtime returns `{ ok: false, timedOut: true, error: '…', usage: U }` → planner run status `'timed_out'`, story `planning_failed`, one `model_usage` row. Same pattern in `implementer.test.ts` and `reviewer.test.ts` for their timeout paths, and one interrupted case each → status `'interrupted'` with a usage row.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{agent-runtime,finish-run,planner,implementer,reviewer}.test.ts` → FAIL.
- [ ] **Step 3: Implement** runtime changes, `finishRun`, replace the nine sites (reviewer's success site calls `finishRun(tx, …)` inside its transaction).
- [ ] **Step 4: Run** the same command → PASS; run `npx vitest run apps/orchestrator` → PASS.
- [ ] **Step 5: Commit** — `feat(orchestrator): finish every agent run through finishRun with usage and timed_out`

---

### Task 5: Usage API, StoryDTO cost, dashboard dollars, probe usage (W0-1)

**Files:**
- Modify: `apps/orchestrator/src/metrics/usage-service.ts`, `apps/orchestrator/src/api/routes/metrics.ts`, `packages/contracts/src/stories.ts:8` (`StoryDTO`), `apps/orchestrator/src/stories/dto.ts:7`, `apps/ui/src/components/UsageDashboard.tsx` (:8-38 types, :71 props, :113 "(REL-5)"), `apps/ui/src/routes/usage.tsx:7`, `apps/desktop/src/main/opencode-server.ts:313` (`opencodeChat`) and its `OpencodeChatResult` type, `apps/ui/src/routes/settings.tsx:186`
- Create: `apps/ui/src/lib/usage-format.ts`, `apps/ui/test/usage-format.test.ts`, `apps/orchestrator/test/usage-metrics.test.ts` (or extend the existing usage-service test if present)

**Interfaces:**
- Consumes: `recordUsage` (Task 3), `extractSessionUsage` (Task 2).
- Produces:
  - `UsageQuerySchema` adds `storyId: z.coerce.number().int().positive().optional()`.
  - `UsageSummaryDTO` adds `totalCostUsd: number; costComplete: boolean; estimated: boolean; byDay: { day: string /* YYYY-MM-DD local */; costUsd: number; runs: number }[]; byProject: { projectId: number; projectKey: string; costUsd: number; runs: number }[]`; `UsageModelBreakdown` adds `costUsd: number`. `costComplete` = no row in range has `costSource 'unknown'`; `estimated` = any row has `'estimated'`. Success for rows with `httpStatus NULL`: when `agentRunId` is set, success = linked `agent_runs.status = 'succeeded'`; probe rows (`agentRunId NULL`, `httpStatus NULL`) count as successes (a probe row is only written after a successful test prompt). Joins to `modelProfiles`/`providers` become LEFT joins; `projectId`/`storyId` filters use `model_usage.project_id` / `story_id` directly (so probe rows with no run are counted when unfiltered).
  - `POST /metrics/usage/probe` body `{ providerId: string; modelId: string; usage: SessionUsage | null; durationMs: number | null }` (zod-validated, via `mutation()`), calls `recordUsage` with run/story/project null; 201 `{ id, costUsd, costSource }`.
  - `StoryDTO` adds `costUsd: number | null` (sum over the story's `model_usage` rows; `null` when it has no rows) and `costComplete: boolean`.
  - `OpencodeChatResult` (desktop) adds `usage?: SessionUsage | null; durationMs?: number`; `opencodeChat` sets them from the messages it already fetches. Settings page, after a successful test prompt, calls `api.post('/metrics/usage/probe', { providerId, modelId: id, usage, durationMs })` and ignores a failure of that call (shows nothing extra).
  - `apps/ui/src/lib/usage-format.ts`: `formatUsd(value: number | null): string` (`null` → `'—'`, `< 0.01` and `> 0` → `'<$0.01'`, else `$` + 2 decimals with thousands separators), `costLabel(summary: Pick<UsageSummaryDTO, 'costComplete' | 'estimated'>): string | null` (`'estimated'` when estimated, `'incomplete'` when !costComplete, both → `'estimated · incomplete'`, else null).
  - UI: dashboard shows total cost tile with `costLabel` marker, a `$` column per model, a project `<select>` (options from `GET /projects`, "All projects" default) wired to the existing `projectId` prop / query; subtitle text loses "(REL-5)".
- [ ] **Step 1: Failing tests**
  - `usage-metrics.test.ts`: seed rows (reported 0.10 for story A/project P1, estimated 0.05 project P2, unknown project P1, probe row with no project) → unfiltered `totalCostUsd 0.15`, `costComplete false`, `estimated true`, `byProject` has P1 0.10 and P2 0.05; `?projectId=P1` excludes the probe row; `?storyId=A` → 0.10; probe route via `buildTestApp().inject('POST','/metrics/usage/probe', …)` → 201 and row exists (register metrics routes in `test/helpers/app.ts` if absent).
  - `stories` DTO: story with two rows (0.1 reported, unknown) → `costUsd 0.1`, `costComplete false`; story without rows → `costUsd null`, `costComplete true`.
  - `usage-format.test.ts`: `formatUsd(null)` `'—'`, `formatUsd(0.004)` `'<$0.01'`, `formatUsd(1234.5)` `'$1,234.50'`, `formatUsd(0)` `'$0.00'`; `costLabel` four cases.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/usage-metrics.test.ts apps/ui/test/usage-format.test.ts apps/orchestrator/test/stories.test.ts` → FAIL.
- [ ] **Step 3: Implement** service, route, DTO, desktop result, UI.
- [ ] **Step 4: Run** → PASS. Add to `e2e/tests/usage.spec.ts` (create if absent): the Usage page renders a cost tile and has no "(REL-5)" text. Run `npm run e2e -- usage` → PASS.
- [ ] **Step 5: Commit** — `feat(usage): cost totals, story cost and dollar dashboard`

---

### Task 6: Settings-form logic, API error details, scanner probe endpoint (W0-2)

**Files:**
- Create: `apps/ui/src/lib/project-settings.ts`, `apps/ui/test/project-settings.test.ts`, `apps/orchestrator/test/scanner-probe.test.ts`
- Modify: `apps/ui/src/lib/api.ts:3-21` (`ApiRequestError`), `apps/orchestrator/src/security/vulnerability.ts`, `apps/orchestrator/src/api/routes/projects.ts`

**Interfaces:**
- Produces:
  - `ApiRequestError` gains `readonly details: unknown` (from the response body's `error.details`).
  - `apps/ui/src/lib/project-settings.ts`:
    - `export type SettingsDraft = ProjectSettings` (from `@aik/contracts`).
    - `export const SETTINGS_GROUPS: readonly { id: 'verification' | 'automation' | 'safety' | 'github'; title: string; fields: readonly SettingsFieldMeta[] }[]` with `SettingsFieldMeta = { path: string; label: string; enforced: boolean; note?: string }`. Groups and fields (exact): **verification** `checks`, `secretsOnlyVerification`, `cleanroomVerification`, `vulnerabilityScan.enabled`, `vulnerabilityScan.threshold`, `vulnerabilityScan.scannerPath`; **automation** `autoAcceptPlans`, `maxAttempts`; **safety** `protectedPaths`, `shellAllowlist` (enforced **false**, note `'Not enforced yet — agents may run any command.'`), `allowPaid` (false), `allowMayTrain` (false), `webfetch` (false), `budgets.requestsPerRun` / `budgets.requestsPerStory` / `budgets.inputTokensPerStory` (false), `jobLimits.memoryMb` / `jobLimits.maxProcesses` (false); **github** `publish`, `remoteMerge`, `requireRemoteChecks`, `mergeMethod`. Every not-enforced field note is `'Not enforced yet.'` unless stated. A test asserts every leaf key of `defaultProjectSettings()` appears in exactly one group (with `checks` and `vulnerabilityScan.scannerSha256` as the allowed exceptions: `scannerSha256` is shown read-only under verification as `{ path: 'vulnerabilityScan.scannerSha256', enforced: true, note: 'Set together with the scanner path.' }`).
    - `mergeDetectedChecks(current: CheckConfig[], detected: DetectedCheck[]): CheckConfig[]` — keeps current checks, appends detected ones whose `key` is not present (drops `source`).
    - `issuesByField(details: unknown): Record<string, string>` — from zod issues `{ path: (string|number)[]; message }`, strips a leading `'settings'` segment, joins with `.` (`['settings','checks',1,'command']` → `'checks.1.command'`); first message per path wins; non-array input → `{}`.
    - `buildPatch(draft: SettingsDraft): { settings: ProjectSettings }` — the full object (PATCH replaces settings wholesale).
    - `needsChecksBanner(settings: ProjectSettings): boolean` — `checks.length === 0 && !secretsOnlyVerification`.
  - Orchestrator: `probeScanner(cfg: { scannerPath?: string }): Promise<{ found: boolean; path: string; version: string | null; error: string | null }>` in `vulnerability.ts` — runs `<scannerPath ?? 'osv-scanner'> --version` with `execFile(file, ['--version'], { timeout: 10_000, windowsHide: true, shell: isWinScript })` where `isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)` (Node refuses to `execFile` a `.cmd`/`.bat` without a shell); when `isWinScript`, pass the file double-quoted; `path` = configured path or `'osv-scanner (PATH)'`; ENOENT → `{ found: false, error: 'not found' }`. Route `GET /projects/:id/vulnerability-scanner` returns it for the project's settings.
- [ ] **Step 1: Failing tests**
  - `project-settings.test.ts`: group coverage test above; `issuesByField([{ path: ['settings','checks',1,'command'], message: 'Too small' }])` → `{ 'checks.1.command': 'Too small' }`; `issuesByField('x')` → `{}`; `mergeDetectedChecks` keeps order and skips duplicate `test`; `needsChecksBanner` 3 cases; `ApiRequestError` keeps `details` (construct via the module with a mocked `window.api.request` returning `{ status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'm', details: [1] } } }` using `vi.stubGlobal('window', …)`).
  - `scanner-probe.test.ts`: `probeScanner({ scannerPath: path.join(tmp, 'missing.exe') })` → `found false`, `error 'not found'`; with a temp script that prints `osv-scanner version: 1.9.0` (a `.cmd` on Windows / shell script elsewhere created in `makeTempDir`) → `found true`, `version` contains `1.9.0`; route returns the probe for a seeded project.
- [ ] **Step 2: Run** `npx vitest run apps/ui/test/project-settings.test.ts apps/orchestrator/test/scanner-probe.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(settings): project settings form logic and scanner probe`

---

### Task 7: Project settings page, board banner and entry points (W0-2)

**Files:**
- Create: `apps/ui/src/routes/project-settings.tsx`, `e2e/tests/project-settings.spec.ts`
- Modify: `apps/ui/src/router.tsx` (new `projectSettingsRoute`, path `/projects/$projectId/settings`, added to `addChildren`), `apps/ui/src/routes/board.tsx` (Settings tab in `project-tabs` nav :43-63; banner after `</TopBar>` :92), `apps/ui/src/components/ui/field.tsx` (`TextField` gains optional `error?: string` → renders `<p role="alert" id=…>` and sets `aria-invalid` + `aria-describedby`)

**Interfaces:**
- Consumes: everything from Task 6 (`SETTINGS_GROUPS`, `issuesByField`, `mergeDetectedChecks`, `buildPatch`, `needsChecksBanner`, `ApiRequestError.details`), `GET /projects/:id`, `GET /projects/:id/checks/proposal`, `GET /projects/:id/vulnerability-scanner`, `PATCH /projects/:id`.
- Produces: page `ProjectSettingsPage` with `data-testid`s: `project-settings`, `settings-group-<id>`, `settings-field-<path>`, `settings-detect-checks`, `settings-save`, `settings-saved`, `settings-error`, `scanner-status`, and board banner `checks-banner` with button `checks-banner-open` linking to `/projects/$projectId/settings?section=verification` (search param validated like `boardRoute`'s `terminal`; when present the page runs detection once on load and scrolls to the verification group).
- Page behaviour: loads project → draft state; checks table editor (key, command, mandatory checkbox, timeout seconds; add/remove row); "Detect checks" merges proposals into the draft (not saved until Save); every field from `SETTINGS_GROUPS` rendered; not-enforced fields show their note; scanner status line from the probe (`Found: <version>` / `Not found at <path>`); Save sends `buildPatch(draft)`; on `ApiRequestError` with `code 'VALIDATION_FAILED'` shows `issuesByField(err.details)` next to fields and a summary in `settings-error`; on success shows `settings-saved`. Uses `Card`, `Label`, `Select`, `Button`, `TextField`, and the `CheckRow`-style checkbox pattern from `settings.tsx:303-348` (copy the small helpers into the new page; do not export from settings.tsx).
- [ ] **Step 1: Write the failing Playwright spec** `e2e/tests/project-settings.spec.ts` using the fixtures in `e2e/fixtures.ts` (follow `board.spec.ts` for creating a project in a temp repo containing a `package.json` with `"test"` and `"lint"` scripts):
  - new project board shows `checks-banner`; clicking `checks-banner-open` lands on the settings page with detected `test` and `lint` rows in the draft;
  - Save → `settings-saved`; back on the board the banner is gone;
  - clearing a check's command and saving shows an inline error under that command field and `settings-error`;
  - `shellAllowlist` field shows "Not enforced yet — agents may run any command.";
  - `scanner-status` is visible.
- [ ] **Step 2: Run** `npm run e2e -- project-settings` → FAIL.
- [ ] **Step 3: Implement** page, route, field error, board tab + banner.
- [ ] **Step 4: Run** `npm run e2e -- project-settings` and `npm run e2e -- board` → PASS; `npm run typecheck` clean except tolerated files.
- [ ] **Step 5: Commit** — `feat(ui): project settings page with check detection and onboarding banner`

---

### Task 8: Story details expose plan meta and the previous rejected plan (W0-3)

**Files:**
- Modify: `apps/orchestrator/src/stories/service.ts:660-690` (`getDetails`), `apps/orchestrator/test/stories.test.ts:340`

**Interfaces:**
- Produces: `GET /stories/:id/details` response adds
  - `planMeta: { version: number; status: PlanStatus; approvedBy: string | null; createdAt: number } | null` for the plan currently returned in `plan`;
  - `previousPlan: { version: number; content: PlanV1; rejectionFeedback: string | null } | null` — the highest-version plan with `status = 'rejected'` and `version < planMeta.version`, else null.
  (`approvedBy` comes from the existing `plans.approvedBy` column, set by `applyEffects` in `workflow/service.ts`.)
- [ ] **Step 1: Failing test** in `stories.test.ts`: seed plan v1 rejected with feedback "Too broad", plan v2 proposed → details `planMeta.version 2`, `planMeta.status 'proposed'`, `previousPlan.version 1`, `previousPlan.rejectionFeedback 'Too broad'`; a story with only v1 → `previousPlan null`.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/stories.test.ts -t details` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(stories): include plan meta and previous rejected plan in details`

---

### Task 9: Plan view logic, Approve-plan button, plan details in the modal (W0-3)

**Files:**
- Create: `apps/ui/src/lib/plan-view.ts`, `apps/ui/test/plan-view.test.ts`, `e2e/tests/plan-approval.spec.ts`
- Modify: `apps/ui/src/lib/transitions.ts` (add `approvePlan`), `apps/ui/src/components/kanban/terminal-modal.tsx` (`StoryDetailsResponse` :52-89; banner :829-847 incl. text at :834; plan body :869-905), `apps/ui/src/components/kanban/card.tsx` (badge for `plan_proposed` / `planning_failed`)

**Interfaces:**
- Consumes: Task 8 response fields; `POST /stories/:id/transitions` with `{ event: 'approve_plan', planVersion, expectedVersion }` (`packages/contracts/src/stories.ts:108-131`).
- Produces:
  - `approvePlan(story: StoryDTO): Promise<void>` in `transitions.ts` — same error handling as `rejectPlan` (:77-94); throws when `story.activePlanVersion` is null.
  - `apps/ui/src/lib/plan-view.ts`:
    - `planToLines(plan: PlanV1): string[]` — exact line format, in this order: `Summary: <summary>`; `Complexity: <S|M|L|XL>`; each assumption `Assumption: <text>`; each risk `Risk: <text>`; each AC `AC <ref>: <text> — verify: <verification>`; each subtask `Subtask <id>: <description>` followed by `  file: <path>` per file.
    - `diffPlanLines(prev: PlanV1, next: PlanV1): { kind: 'same' | 'added' | 'removed'; text: string }[]` — line diff over `planToLines` using a longest-common-subsequence alignment (removed lines appear before added lines at each change point).
    - `planBadge(story: Pick<StoryDTO, 'status' | 'planningStatus'>): { label: string; tone: 'info' | 'warning' } | null` — NEW + `plan_proposed` → `{ 'Plan ready for approval', 'info' }`; NEW + `needs_clarification` → `{ 'Needs your answers', 'info' }`; NEW + `planning_failed` → `{ 'Planning failed — retrying', 'warning' }`; else null.
  - Modal: banner text becomes `Review the plan, then approve it or reject it — the planner re-plans with your feedback.` with buttons **Approve plan** (`data-testid="modal-approve-plan-<KEY>"`, calls `approvePlan`, then `onChanged`) and the existing Reject. Plan body additionally renders Assumptions, Risks, Acceptance criteria (ref, text, verification) when non-empty, and, when `previousPlan` exists, a collapsible "Changes since version N" section listing `diffPlanLines` with +/- markers and the previous rejection feedback quoted. Card shows `planBadge` and an **Approve plan** button (`data-testid="card-approve-plan-<KEY>"`) when `planning_status = plan_proposed`.
- [ ] **Step 1: Failing tests**
  - `plan-view.test.ts`: `planToLines(TEST-like plan with 1 assumption, 1 risk, AC ref 'AC-1', subtask with 2 files)` equals the exact expected array; `diffPlanLines` where only the summary changed → one `removed` + one `added` + rest `same`; identical plans → all `same`; `planBadge` four cases; `approvePlan` posts `{ event: 'approve_plan', planVersion: 2, expectedVersion: 5 }` (mocked `api.post`).
  - `e2e/tests/plan-approval.spec.ts` (no existing spec drives a planner; build it from the existing fixtures): `test.skip(!resolveOpencodeExe(), 'needs the OpenCode binary')` at the top (managed mode needs a real OpenCode, `opencode-server.ts:200-208`); start `startMockLlm` (`e2e/fixtures.ts:30-53`) scripted to answer every request with a fenced `PlanV1` JSON (empty `clarificationQuestions`, one subtask, `complexity: 'S'`); `launchApp(dataDir, { AIK_OPENCODE_BASE_URL: mockUrl })` (managed config turns it into the `mock` provider, `opencode-server.ts:116-124`); create a project on a temp repo and a story; wait (≤ 60 s) for the card badge "Plan ready for approval"; click `card-approve-plan-<KEY>` → the card is no longer in the NEW column. If the mock LLM cannot satisfy OpenCode's request format, the implementer keeps the vitest coverage only and states that in the commit body (as Task 14 does).
- [ ] **Step 2: Run** `npx vitest run apps/ui/test/plan-view.test.ts` and `npm run e2e -- plan-approval` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(ui): approve plans with a button and show the full plan with changes`

---

### Task 10: Planner never invents a plan — one corrective turn (W0-3)

**Files:**
- Create: `apps/orchestrator/src/agents/plan-parse.ts`, `apps/orchestrator/test/plan-parse.test.ts`
- Modify: `packages/contracts/src/opencode.ts` (`OpenCodeMessageLike` gains `id?: string` — messages carry a stable `msg_…` id, `spikes/spk-1/out/session-messages-aik-implementer.json`), `apps/orchestrator/src/agents/runtime.ts` (add `continueSession`; extract the shared poll-until-idle loop of `runOneShot` lines ~250-339 into a private method used by both), `apps/orchestrator/src/agents/planner.ts` (remove `parsePlan` :316-341; :252 flow), `apps/orchestrator/test/planner.test.ts`, `apps/orchestrator/test/agent-runtime.test.ts`

**Interfaces:**
- Consumes: Task 4 (`RunOneShotOutput.sessionId/usage/timedOut`, `finishRun`).
- Produces:
  - `parsePlanText(text: string): { ok: true; plan: PlanV1 } | { ok: false; error: string }` — accepts a fenced ```` ```json ```` block or bare JSON; `error` is the JSON parse message or `z.prettifyError` of the PlanV1 failure, truncated to 1000 chars.
  - `ContinueSessionInput = { sessionId: string; directory: string; prompt: string; timeoutMs: number; shouldStop?: () => boolean; onActivity?: (e: RunActivityEvent) => void }`; `OpenCodeRuntime.continueSession(input): Promise<RunOneShotOutput>`.
  - **Turn horizon (required).** `sessionHasCompleted` (`packages/contracts/src/opencode.ts:75-77`) is true for *any* `idle` message, and a resumed session still holds turn 1's `idle`; during the start-grace window (`START_GRACE_MS`, `runtime.ts:73`) the loop would stop at once and return turn 1's text. So the extracted poll loop takes a **baseline**: `continueSession` first fetches `/api/session/{id}/message` and records the baseline message identities (message `id` when present, else the index from the oldest end — messages are returned newest first); then it `POST`s `/api/session/{id}/prompt` `{ text }`. Inside the loop, completion (`idle`), failure detection, `extractAssistantText`, and the activity diff consider **only messages not in the baseline**. The activity diff state is seeded by running `diffActivity` over the baseline once with output discarded, so turn 1's tool parts are not re-emitted. `runOneShot` uses the same loop with an empty baseline. Timeout/interrupt handling is unchanged. `usage` is computed from the **whole** session (cumulative over both turns).
  - Planner flow after the first result: `parsePlanText`; on `ok:false` → one `continueSession` with the remaining time of `ROLE_TIMEOUTS.planner` and prompt exactly:
    ```
    Your previous answer could not be used as a plan: <error>
    Reply again with ONLY the plan as one JSON object that matches the schema given earlier, inside a ```json block. Do not add any other text.
    ```
    Second `ok:false` → `finishRun` status `'failed'`, `exitReason = 'invalid_plan_output: ' + error.slice(0, 300)`, story `planningStatus 'planning_failed'` (same story update as today's :236-250 path), no `plans` row. Usage passed to `finishRun` is the **last** returned `usage` (cumulative), so both turns are counted once. Interrupt/timeout during the corrective turn follow the existing interrupted/timeout paths.
- [ ] **Step 1: Failing tests**
  - `plan-parse.test.ts`: fenced valid → ok; bare valid → ok; prose → `ok:false` with a JSON error; valid JSON missing `subtasks` → `ok:false` mentioning `subtasks`.
  - `planner.test.ts` (fake runtime with `runOneShot` + `continueSession` vi.fns):
    - prose then valid JSON → plan v1 `proposed`, run `succeeded`, `continueSession` called once with a prompt starting `Your previous answer could not be used as a plan:`; `failedPlannerRuns` unchanged (0).
    - prose twice → run `failed` with `exitReason` starting `invalid_plan_output:`, story `planning_failed`, **zero** `plans` rows, one `model_usage` row whose `inputTokens` equals the second (cumulative) usage.
    - prose then timeout → run `timed_out`, story `planning_failed`.
  - `agent-runtime.test.ts` (extend the existing fake OpenCode server): `continueSession` posts to `/api/session/<id>/prompt` on the same id and returns the **new** assistant text; with `sessionStartDelayPolls: 3` and turn 1's `idle` + prose already in the session, it still waits and returns the corrective answer (not turn 1's prose); `onActivity` receives no event for a tool part that belonged to turn 1; `usage.inputTokens` equals the sum over both turns.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{plan-parse,planner,agent-runtime}.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(planner): retry once with the validation error instead of inventing a plan`

---

### Task 11: Planning budget per round (B7)

**Files:**
- Create: `apps/orchestrator/src/agents/planning-budget.ts`, `apps/orchestrator/test/planning-budget.test.ts`
- Modify: `apps/orchestrator/src/agents/runner.ts` (:24 constant, `discoverPlanning` :269-301, `failedPlanCount` :304-310), `apps/orchestrator/src/agents/stuck-stories.ts` (:23 constant, NEW case :252-264, `failedPlannerRuns` :361-367), `apps/orchestrator/test/runner.test.ts` (:316-404 key expectations), `apps/orchestrator/test/stuck-stories.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_PLANNING_ATTEMPTS = 3;` (runner and stuck-stories import it; delete their local constants)
  - `lastPlanningReset(db: AikDbOrTx, storyId: number): { eventId: number; at: Date } | null` — newest `story_events` row with `type = 'transition'` and `json_extract(payload,'$.event.type') = 'edit_definition'` OR (`json_extract(payload,'$.event.type') = 'recover'` AND `json_extract(payload,'$.event.target') = 'NEW'`), ordered by `id` desc.
  - `failedPlannerRunsSinceReset(db: AikDbOrTx, storyId: number): number` — failed **or timed_out** planner `agent_runs` with `startedAt > reset.at` (all of them when no reset). (Counting `timed_out` keeps Task 4's new status inside the budget.)
  - Plan job idempotency key becomes `auto_plan_${id}_${revision}_v${planCount + 1}_a${failed}_s${reset?.eventId ?? 0}`.
- [ ] **Step 1: Failing tests**
  - `planning-budget.test.ts`: 3 failed runs, then a `recover`→NEW transition event (insert via `WorkflowService` using a real BLOCKED story arranged with `forceStory`), then 1 failed run with later `startedAt` → `failedPlannerRunsSinceReset === 1`; an `edit_definition` reset works the same; no reset → counts all; a `timed_out` planner run counts.
  - `runner.test.ts`: update key expectations to the new `_s<id>` suffix; new test: story blocked after 3 failures, recovered to NEW → runner enqueues a plan job (key ends `_a0_s<eventId>`), and after 2 more failures still enqueues (budget 3 per round).
  - `stuck-stories.test.ts`: after recover→NEW, a `planning_failed` story with 3 old + 1 new failure is **not** blocked.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{planning-budget,runner,stuck-stories}.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(runner): reset the planning budget after re-plan or edit`

---

### Task 12: Vulnerability scan fails closed (W0-4)

**Files:**
- Modify: `apps/orchestrator/src/security/vulnerability.ts` (default runner :274-290, `parseOsvOutput` :128-177, main flow :292-308), `apps/orchestrator/src/verify/runner.ts` (:171-196 infrastructure message), `packages/contracts/src/hints.ts:17`, `apps/orchestrator/test/vulnerability-scan.test.ts` (:126 expectation changes), `apps/orchestrator/test/verification.test.ts`

**Interfaces:**
- Produces:
  - Scanner callback result gains `spawnError?: string` (set to the error `code`, e.g. `'ENOENT'`, when the process could not start) — both in `VulnerabilityScannerOptions.scanner` and in the `vulnerabilityScanner` dep type of `verify/runner.ts:19-23`.
  - `parseOsvOutput(json: string): OsvFinding[] | null` — `null` for empty, non-JSON, or missing `results` array (was `[]`). Valid JSON with `results: []` still → `[]`.
  - `runVulnerabilityScan` returns `status: 'error'` with `summary`:
    - spawn ENOENT → `osv-scanner not found at ${cfg.scannerPath ?? 'osv-scanner (PATH)'}`
    - other spawn error → `osv-scanner could not start: ${code}`
    - `parseOsvOutput` → `null` → `osv-scanner output could not be read (exit ${exitCode})`
  - `verify/runner.ts` infrastructure error string becomes `Mandatory checks cannot run: ${list}` where each item is `${key} (${status}${firstLine ? ': ' + firstLine : ''})` and `firstLine` is the first line of the check's redacted `outputTail` (so blockedDetail reads e.g. `Mandatory checks cannot run: vulnerabilities (error: osv-scanner not found at osv-scanner (PATH))`).
  - `BLOCKED_HINTS.environment` = `'A required tool, disk space, or the repository path is unavailable. Install or fix it, or turn the check off in the project settings, then resume.'`
- [ ] **Step 1: Failing tests**
  - `vulnerability-scan.test.ts`: `parseOsvOutput('')` → `null`; `parseOsvOutput('not json')` → `null`; `parseOsvOutput('{"results":[]}')` → `[]`; scan with injected scanner returning `{ stdout: '', stderr: '', exitCode: 1, spawnError: 'ENOENT' }` and a changed lockfile → `status 'error'`, summary `osv-scanner not found at osv-scanner (PATH)`; scanner returning garbage stdout → `status 'error'`, summary starts `osv-scanner output could not be read`.
  - `verification.test.ts`: enabled scan + ENOENT scanner + lockfile change → verification result `blockedReason 'environment'`, `error` contains `vulnerabilities (error: osv-scanner not found`; story ends BLOCKED(environment) through the runner path (use the runner test pattern `runnerWith`/`tick`/`drain`) with `blockedDetail` containing `osv-scanner not found`.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{vulnerability-scan,verification}.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(security): fail the vulnerability scan closed when the scanner is missing`

---

### Task 13: Protected-path acknowledgement at merge approval — server (W0-4)

**Files:**
- Create: `apps/orchestrator/src/stories/protected-ack.ts`, `apps/orchestrator/test/protected-ack.test.ts`
- Modify: `packages/contracts/src/stories.ts:123` (`approve_merge`), `apps/orchestrator/src/stories/service.ts` (`approve_merge` :295-364; `getDetails` adds `protectedPaths`), `apps/orchestrator/test/merge-approval.test.ts`, `packages/contracts/test/schemas.test.ts:66`

**Interfaces:**
- Produces:
  - `approve_merge` request: `{ event: 'approve_merge', sha: Sha, method?: 'merge'|'squash', acknowledgedProtectedPaths?: z.array(z.string().min(1).max(500)).max(200), note?: z.string().trim().max(2000) }`.
  - `protectedPathsForCandidate(db: AikDbOrTx, storyId: number, candidateSha: string): string[]` — from the newest `story_events` transition whose `payload.event.type === 'candidate_committed'` and `payload.event.candidateSha === candidateSha`; returns its `protectedPaths` normalised (`\`→`/`), de-duplicated, sorted; `[]` when absent.
  - `sameProtectedPaths(a: readonly string[], b: readonly string[]): boolean` — set equality after the same normalisation.
  - `approve_merge` handling, before inserting the approval and inside the same transaction: compute `matched = protectedPathsForCandidate(...)`; if `!sameProtectedPaths(matched, req.acknowledgedProtectedPaths ?? [])` → `ApiHttpError(409, 'GUARD_FAILED', 'Acknowledge the protected paths changed by this candidate before merging', { failedGuards: [{ guard: 'protected_paths_acknowledged', reason: 'Acknowledge the protected paths changed by this candidate before merging' }], details: { protectedPaths: matched } })` (`failedGuards` is `FailedGuard[]` = `{ guard, reason }[]`, `api/errors.ts:8-16`, `contracts/src/common.ts:20-29`), nothing written. Otherwise the inserted `merge_approvals.note` = `JSON.stringify({ protectedPathsAcknowledged: matched, text: req.note ?? null })` when `matched.length > 0 || req.note`, else `null`; and when `matched.length > 0` and the approval row was newly created, insert `story_events` `{ type: 'protected_paths_acknowledged', actor: 'human', fromStatus: null, toStatus: null, payload: { candidateSha, paths: matched }, idempotencyKey: \`ppa_${storyId}_${candidateSha}\` }`.
  - `GET /stories/:id/details` adds `protectedPaths: string[]` (for the current `candidateSha`, `[]` when none).
- [ ] **Step 1: Failing tests**
  - `protected-ack.test.ts`: two `candidate_committed` events for different SHAs → returns the list for the requested SHA, normalised and sorted; `sameProtectedPaths(['b','a\\x'], ['a/x','b'])` true.
  - `merge-approval.test.ts`: story AWAITING_MERGE whose candidate touched `.github/workflows/ci.yml` (arrange by inserting the transition event through a real `candidate_committed` path or a direct insert into `story_events` in the arrange step) →
    - approve without ack → 409 `GUARD_FAILED` with `failedGuards` containing `{ guard: 'protected_paths_acknowledged' }` and `details.protectedPaths` `['.github/workflows/ci.yml']`, no `merge_approvals` row, no merge job;
    - approve with ack `['.github/workflows/ci.yml']` and note `'checked'` → 200, approval `note` parses to `{ protectedPathsAcknowledged: ['.github/workflows/ci.yml'], text: 'checked' }`, one `protected_paths_acknowledged` story event;
    - ack for the old list after a newer `candidate_committed` (different SHA, different paths) and `sha` = new candidate → 409, nothing written;
    - candidate with no protected paths + no ack → 200, `note` null, no story event.
  - `schemas.test.ts`: `approve_merge` accepts the new optional fields and rejects 201 paths.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{protected-ack,merge-approval}.test.ts packages/contracts/test/schemas.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(merge): require acknowledging protected paths before merge approval`

---

### Task 14: Protected-path acknowledgement — UI (W0-4)

**Files:**
- Create: `apps/ui/src/lib/merge-ack.ts`, `apps/ui/test/merge-ack.test.ts`, `e2e/tests/merge-ack.spec.ts` (only if the e2e fixtures can produce an AWAITING_MERGE story touching a protected path; otherwise the vitest logic test is the coverage and the plan executor notes it in the commit body)
- Modify: `apps/ui/src/components/kanban/terminal-modal.tsx` (`handleApproveMerge` :381-409, button :591-601, `StoryDetailsResponse`)

**Interfaces:**
- Consumes: details `protectedPaths` and the `approve_merge` fields (Task 13).
- Produces:
  - `approveMergeBody(story: Pick<StoryDTO, 'candidateSha' | 'statusVersion'>, protectedPaths: readonly string[], acknowledged: boolean, note: string): { event: 'approve_merge'; sha: string; expectedVersion: number; acknowledgedProtectedPaths?: string[]; note?: string }` — includes `acknowledgedProtectedPaths` only when `protectedPaths.length > 0` (then it equals them); `note` only when non-blank (trimmed).
  - `canApproveMerge(protectedPaths: readonly string[], acknowledged: boolean): boolean` — `protectedPaths.length === 0 || acknowledged`.
  - Modal: when `protectedPaths.length > 0`, above Approve & Merge render a warning box listing the paths and a checkbox `data-testid="merge-ack-<KEY>"` labelled `I reviewed the changes to these protected paths`; button disabled until `canApproveMerge`. An `ApiRequestError` with status 409 and `err.failedGuards.some((g) => g.guard === 'protected_paths_acknowledged')` refetches details, clears the checkbox and shows toast `The protected paths changed — review them again.` Export this check as `isProtectedPathsGuardError(err: unknown): boolean` from `merge-ack.ts` and test it (true for that guard object, false for other guards / non-ApiRequestError).
- [ ] **Step 1: Failing tests** (`merge-ack.test.ts`): body without paths has no `acknowledgedProtectedPaths`; with paths includes them; blank note omitted; `canApproveMerge` 3 cases.
- [ ] **Step 2: Run** `npx vitest run apps/ui/test/merge-ack.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (and the e2e spec if created).
- [ ] **Step 5: Commit** — `feat(ui): acknowledge protected paths before approving a merge`

---

### Task 15: Skills reach the agent — recommendations, inline bodies, recording (W0-5)

**Files:**
- Create: `apps/orchestrator/src/skills/run-skills.ts`, `apps/orchestrator/test/run-skills.test.ts`
- Modify: `apps/orchestrator/src/skills/bridge.ts` (types :12-32, `injectSkills` :97-160), `apps/orchestrator/src/agents/{planner,implementer,reviewer}.ts` (call sites `planner.ts:138-146`, `implementer.ts:139-147`, `reviewer.ts:230-238`), `apps/orchestrator/test/skills-bridge.test.ts`, `implementer.test.ts:281-300`, `reviewer.test.ts:681`, `planner.test.ts:378-403`

**Decision recorded (spec Q-V3):** SPK-1 never tested project-level `.opencode/skills` under `OPENCODE_DISABLE_PROJECT_CONFIG=1` (managed mode sets it, `opencode-server.ts:216`), so W0 delivers skill **content inline in the prompt** (the spec's fallback). File copying stays (it helps personal mode) but nothing relies on it.

**Interfaces:**
- Consumes: `recommendForRepo(db: VaultDb, { repoRoot, task, limit, statuses })` from `@aik/skill-vault` (`recommend.ts:35`); `skillDirFor(paths, row)` from `@aik/skill-vault` (defined `apps/skill-vault/src/paths.ts:100-102`, already exported from `index.ts:39`), where `row` is the vault's raw `SkillRow` (snake_case: `id`, `name`, `repo_owner`, `repo_name`, `skill_path`, `status`, `content_sha256` — see the fixture insert in `skills-bridge.test.ts:66-82`) and the SKILL.md path is `path.join(skillDirFor(paths, row), 'SKILL.md')`; `runSkills` table (Task 1).
- Produces:
  - Recommendations use the existing `InjectSkillsInput.repoPath` (the project repo, already passed by all three callers) as `repoRoot`, even when `targetDirectory` is a worktree. No new input field.
  - `export interface DeliveredSkill { id: string; name: string; contentSha256: string; bytes: number }`; `InjectSkillsResult` becomes `{ injected: InjectedSkillSummary[]; delivered: DeliveredSkill[]; promptHint: string }`.
  - Selection: role defaults (existing `ROLE_DEFAULT_SKILLS` map, `bridge.ts:34-38`, `status='approved'`) first, then `recommendForRepo(..., { repoRoot, task: \`${storyTitle}\n${storyDescription ?? ''}\`, limit: 5, statuses: ['approved'] }).recommendations` by score; de-duplicate by `id`; keep at most **3**.
  - Content: read each selected skill's `SKILL.md` via `skillDirFor(paths, row)`; budget **12 288 bytes** (UTF-8) of bodies total, in selection order; a skill whose body does not fit the remaining budget is skipped (logged), later smaller ones may still fit. `contentSha256` = sha256 hex of the delivered body.
  - `promptHint` format (exact):
    ```
    SKILLS — follow these when they apply to the task:
    === SKILL: <name> ===
    <body>
    === END SKILL ===
    ```
    (one block per delivered skill; empty string when none delivered).
  - Any vault error → `{ injected: [], delivered: [], promptHint: '' }` (unchanged degradation).
  - `recordRunSkills(db: AikDbOrTx, now: Date, agentRunId: number, delivered: readonly DeliveredSkill[]): void` — inserts `run_skills` rows (`onConflictDoNothing`). Each agent calls it right after `injectSkills` (the planner and implementer already have `run.id` at that point; the reviewer calls it after its run row exists — move the `injectSkills` call after run creation if needed).
- [ ] **Step 1: Failing tests**
  - `skills-bridge.test.ts` (vault fixture pattern at :43-100): approved `writing-plans` (role default) + approved `react-forms` whose name/description matches a story titled "Add a signup form with React" → planner injection delivers both, defaults first; `promptHint` contains `=== SKILL: writing-plans ===` and the SKILL.md body text; a 20 KB skill is skipped while a later 1 KB skill is delivered; `delivered[i].contentSha256` equals sha256 of the body; quarantined skills never delivered; missing vault → empty result.
  - `run-skills.test.ts`: two delivered skills → two rows; repeat call → still two.
  - Update `implementer.test.ts:281-300`, `reviewer.test.ts:681`, `planner.test.ts:378-403` to assert the new hint text (`SKILLS — follow these`) and that `run_skills` has a row for the run.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{skills-bridge,run-skills,implementer,reviewer,planner}.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(skills): deliver recommended skill content to agents and record it per run`

---

### Task 16: Diagnostics routes and app wiring (W0-6, server)

Implements the never-done Task 4 of `docs/superpowers/plans/2026-11-05-phase-5.4-shortcuts-themes-diagnostics.md` (lines 182-211) — follow that task's route table and wiring exactly; this task only restates what to verify.

**Files:**
- Create: `apps/orchestrator/test/diagnostics-routes.test.ts`
- Modify: `apps/orchestrator/src/api/routes/maintenance.ts`, `apps/orchestrator/src/app.ts:309` (`DiagnosticsService` deps), `apps/orchestrator/test/helpers/app.ts` (register maintenance routes with a `DiagnosticsService` pointing at temp dirs)

**Interfaces:**
- Consumes: `DiagnosticsService` methods `health()`, `recentErrors(limit)`, `listLogs()`, `readLog(name, tailBytes)` (returns `null` when unknown), `listBackups()`, `createBackup(now?)`; contracts `DiagnosticsLogParams`, `DiagnosticsLogQuery`, `DiagnosticsErrorsQuery`; `parse()` and `ApiHttpError`.
- Produces routes: `GET /diagnostics/health`, `GET /diagnostics/errors?limit=`, `GET /diagnostics/logs`, `GET /diagnostics/logs/:file?tailBytes=` (404 `NOT_FOUND` when `readLog` returns null; 400 `VALIDATION_FAILED` for an invalid name), `GET /diagnostics/backups`, `POST /diagnostics/backup` (via `mutation()`, body `{}`). `app.ts` passes `backupsDir: paths.backups`, `electronVersion: opts.versions?.electron ?? null`, and `extraComponents` for opencode (`resolveOpenCodeService()`), gateway (started flag), github (a connected `github_connections` row), ollama (a `providers` row whose kind is `ollama`) — a probe that throws reports `{ status: 'unavailable', detail: 'probe failed' }`.
- [ ] **Step 1: Failing tests** (`diagnostics-routes.test.ts` with `buildTestApp`): each GET returns 200 and the DTO shape (e.g. `health.components.db.status === 'ok'`); unknown log → 404 `NOT_FOUND`; `../x` → 400; `POST /diagnostics/backup` → `{ ok: true }` and then `GET /diagnostics/backups` lists one; a log line containing a fake secret is returned redacted.
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/diagnostics-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npx vitest run apps/orchestrator/test/retention-diagnostics.test.ts apps/desktop/test/bridge-request.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(diagnostics): serve health, errors, logs and backups`

---

### Task 17: Diagnostics page reachable; global shortcuts mounted (W0-6, UI)

Implements the never-done Task 10 (and the e2e part of Task 11) of the Phase 5.4 plan (lines 391-410).

**Files:**
- Create: `e2e/tests/diagnostics.spec.ts`, `e2e/tests/shortcuts.spec.ts`
- Modify: `apps/ui/src/router.tsx` (lazy `diagnosticsRoute` `/diagnostics` via `lazyRouteComponent(() => import('./routes/diagnostics.tsx'), 'DiagnosticsPage')`), `apps/ui/src/routes/root.tsx` (`RootLayout` :65-119), `apps/ui/src/components/shell/sidebar.tsx` (:33-46), `apps/ui/src/routes/settings.tsx:436`

**Interfaces:**
- Consumes: `useGlobalShortcuts(handlers: GlobalShortcutHandlers)`, `ShortcutsDialog({ open, onClose })`, `subscribeShortcutHelp(cb)`, `openShortcutHelp()`, `toggleTheme()` (`lib/theme.ts:181`).
- Produces: `RootLayout` mounts `useGlobalShortcuts` with handlers `mod+1 → '/'`, `mod+2 → '/usage'`, `mod+3 → '/office'`, `mod+, → '/settings'`, `mod+shift+d → '/diagnostics'`, `mod+shift+l → toggleTheme()`, `f1 → open dialog`; renders `<ShortcutsDialog>` inside `ToastProvider`, outside the `<Outlet/>` container; opens it on `subscribeShortcutHelp`. Sidebar: under the main nav, an "Operations" label with a `Diagnostics` link and a `Keyboard shortcuts` button calling `openShortcutHelp()`. Settings subtitle stays `Appearance, runtime and diagnostics` and gains a `Keyboard shortcuts` button calling `openShortcutHelp()`.
- [ ] **Step 1: Failing e2e specs**: `diagnostics.spec.ts` — sidebar Diagnostics link opens the page, `diagnostics-health` visible with no error alert, `diagnostics-backup-create` creates an item; `shortcuts.spec.ts` — all seven global shortcuts: `Control+1` → Projects (`/`), `Control+2` → Usage, `Control+3` → Office, `Control+,` → Settings, `Control+Shift+D` → Diagnostics, `Control+Shift+L` toggles the theme class on `<html>`, `F1` opens the shortcuts dialog and `Escape` closes it.
- [ ] **Step 2: Run** `npm run e2e -- diagnostics shortcuts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npx vitest run apps/ui/test/shortcuts.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): reach diagnostics and enable global shortcuts`

---

### Task 18: Honest empty states in the story modal (W0-7)

**Files:**
- Create: `apps/ui/src/lib/run-log-view.ts`, `apps/ui/test/run-log-view.test.ts`
- Modify: `apps/ui/src/components/kanban/terminal-modal.tsx` (:811-818, :944)

**Interfaces:**
- Produces:
  - `runLogEmptyState(input: { hasRun: boolean; isRunning: boolean }): { title: string; detail: string }` — no run & not running → `{ 'No agent has run yet', 'Logs appear here once an agent starts working on this story.' }`; no run & running (planning starting) → `{ 'Starting an agent…', 'Waiting for the first message.' }`; run & running → `{ 'Agent session started', 'Analyzing repository and preparing reasoning thoughts...' }`; run & not running → `{ 'Agent session ended', 'No message logs recorded.' }`.
  - `formatCheckExit(exitCode: number | null): string` — `null` → `'(no exit code)'`, else `` `(exit ${exitCode})` ``.
  - Modal uses them (`hasRun = Boolean(data?.run)`).
- [ ] **Step 1: Failing tests** for the four states and both exit formats.
- [ ] **Step 2: Run** `npx vitest run apps/ui/test/run-log-view.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(ui): truthful empty states for agent logs and check exit codes`

---

### Task 19: Retention keeps the retry evidence of live stories (W0-7)

**Files:**
- Modify: `apps/orchestrator/src/maintenance/retention.ts:39-51`, `apps/orchestrator/test/retention-diagnostics.test.ts:63`

**Interfaces:**
- Produces: the durable-jobs delete condition becomes `updatedAt < cutoff AND (status IN ('succeeded','cancelled') OR (status IN ('failed','dead') AND (story_id IS NULL OR story_id IN (SELECT id FROM user_stories WHERE status IN ('DONE','CANCELLED')))))`.
- [ ] **Step 1: Failing test**: old `failed` job of a REWORK story is kept; old `failed` job of a DONE story is deleted; old `succeeded` job of a REWORK story is deleted; old `dead` job with `story_id NULL` is deleted; a `model_usage` row older than the cutoff is still present after `prune` (W0-1 AC (e)).
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/retention-diagnostics.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(retention): keep failed jobs of unfinished stories`

---

### Task 20: Resumed review is re-queued (W0-7 silent stall)

**Files:**
- Create: `apps/orchestrator/src/agents/review-status.ts`
- Modify: `apps/orchestrator/src/agents/runner.ts:384-390` (`discoverReview`), `apps/orchestrator/src/agents/stuck-stories.ts:304-325`, `apps/orchestrator/test/runner.test.ts`, `apps/orchestrator/test/stuck-stories.test.ts`

**Interfaces:**
- Produces: `settledReviewFor(db: AikDbOrTx, storyId: number, commitSha: string): { id: number; verdict: 'APPROVED' | 'CHANGES_REQUESTED' } | null` — newest `reviews` row for (story, sha) whose `verdict` is not `BLOCKED`. A BLOCKED review always blocks the story at write time (`reviewer.ts` `finishReview`), so a READY_FOR_REVIEW story whose only review for the SHA is BLOCKED was resumed and must be reviewed again (`reviews` has a non-unique index `review_story_sha_idx`, so a second review row is allowed). `discoverReview` skips only when `settledReviewFor` returns a row; the sweep's READY_FOR_REVIEW case treats "only BLOCKED reviews" like "no review" (its existing no-review handling).
- [ ] **Step 1: Failing tests**: runner — story READY_FOR_REVIEW (arranged with `forceStory`) with one BLOCKED review for its candidate → `tick()` enqueues a `review` job; with an APPROVED review → no job. Stuck-stories — same arrangement → not skipped (handled as missing review).
- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/{runner,stuck-stories}.test.ts -t review` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(runner): re-review a story resumed after a blocking review`

---

### Task 21: Final verification

- [ ] **Step 1:** Run the narrow done-gate commands from Global Constraints → all clean / pass.
- [ ] **Step 2:** Run `npm run e2e` → all specs pass (note any pre-existing failures with their names; none may be in files this plan touched).
- [ ] **Step 3:** Manually confirm spec W0 ACs map to passing tests (table below) and record the result in the PR body.
- [ ] **Step 4:** Commit nothing new unless a fix was needed; push the branch only when the user asks.

## Spec traceability (W0)

| Spec item / AC | Tasks |
|---|---|
| W0-1 (a) reported usage → one row | 2, 3, 4 |
| W0-1 (b) estimated cost | 2, 3 |
| W0-1 (c) local model free | 2 |
| W0-1 (d) Usage page non-zero, $ column, project picker, no "(REL-5)" | 5 |
| W0-1 (e) retention keeps rows | 19 (retention untouched for `model_usage`; Task 19 test asserts a `model_usage` row survives `prune`) |
| W0-1 (f) migration preserves data, FK check | 1 |
| W0-1 probe rows, StoryDTO cost, `usage.recorded` | 3, 5 |
| W0-2 (a)–(d) | 6, 7 |
| W0-3 (a) approve button via WorkflowService | 9 |
| W0-3 (b)(c) corrective turn, no fabricated plan | 10 |
| W0-3 (d) assumptions/risks/AC, diff vs rejected | 8, 9 |
| W0-3 (e) / B7 fresh budget after re-plan | 11 |
| W0-4 (a) scanner fail-closed | 12 |
| W0-4 (b) protected-path ack | 13, 14 |
| W0-4 (c) allowlist enforced or labelled | 6, 7 (labelled "Not enforced yet"; see decision below) |
| W0-5 (a)(b) | 15 |
| W0-6 | 16, 17 |
| W0-7 empty states / timed_out / retention / stall | 18 / 4 / 19 / 20 |

**Decision (spec W0-4 allowlist, Q-V2):** W0 labels `shellAllowlist` "Not enforced yet" instead of enforcing it. SPK-1 finding 4 says per-session `permissions` are evaluated after agent rules and "the orchestrator may pass only **deny** rules per session, never allow rules", and the managed config (`opencode-server.ts:104-125`) is global, not per project, so a per-project allow-list cannot be expressed safely without the Phase 6 runtime permission work. This is the spec's sanctioned fallback.
