# Phase 1 exit check — evidence and notes (2026-10-18)

Recorded per the "Phase 1 exit check (spec §25.2)" section of `2026-10-18-phase-1-walking-skeleton.md`.

## Checklist evidence

| Exit criterion | Evidence |
|---|---|
| The app launches (`npm start`) and shows the dashboard | Smoke run 2026-10-18: `npm start` with `AIK_DATA_DIR` override stayed alive 15 s (5 Electron processes: main, renderer, gpu, utility, orchestrator); teardown via `taskkill /T` left 0 orphans. Dashboard rendering is asserted by `e2e/tests/dashboard.spec.ts` (3/3), which launches the same built bundle from `apps/desktop/dist`. |
| Stories survive restarts | `board.spec.ts › stories persist across restarts` — passing (19/19 suite, two consecutive runs). |
| Illegal drags are rejected with a reason | `board.spec.ts › refuses to drag a story into DONE and explains why` — passing; verdict text asserted, story stays in NEW. |
| SSE replay works | Unit: `apps/orchestrator/src/sse/sse.test.ts` (incl. multi-batch replay of 1,200 events). E2E: `lifecycle.spec.ts › board recovers after orchestrator restart`. |
| API security tests pass | Unit: `apps/orchestrator/src/api/api-security.test.ts`. E2E: `security.spec.ts` (token/Host/Origin/CSP/no-Node-access/second-instance, plus the log-file token guard added at closeout). |

Full gate at closeout (`check:pins` → `lint` → `typecheck` → `test` → `e2e`):
- `All dependency versions are exact.` — lint/typecheck clean.
- Vitest: **334 passed (22 files)**.
- Playwright: **19 passed** twice consecutively (dashboard 3, board 7, lifecycle 4, security 5); after the closeout token-guard test (20th) and the wait-budget raises below: **20 passed**.
- CI (`.github/workflows/ci.yml`) runs the same chain on `windows-latest`; greenness is only claimable from an actual Actions run once pushed.

## Deviations from plan-verbatim code

All are lint- or semantics-preserving; none change behavior:

1. `packages/db/src/schema.ts` (merges table): `(t)` → `(_t)` — unused-parameter lint rule.
2. `apps/orchestrator/src/stories/service.ts` (~line 114): `let current: StoryRow;` without dead initializer — `no-unused-vars`/init-unreachable lint.
3. `apps/desktop/src/main/index.ts`: `BrowserWindow` imported type-only — `verbatimModuleSyntax`/consistent-type-imports lint.
4. `e2e/tests/board.spec.ts` (drag test): explicit mouse gesture instead of `page.dragTo()` — `column-DONE` starts off-screen (10 columns ≈ 3012 px in a 1400 px window) and Playwright scrolls mid-gesture, cancelling the pending native drag. Assertions unchanged.
5. `e2e/tests/board.spec.ts` (`openBoard`): bounded retry of the Settings→Projects navigation — under machine load a click can resolve while the router stays on Settings (verified via saved page snapshot). Assertions unchanged.
6. `e2e/tests/lifecycle.spec.ts` (restart test): added a poll stage waiting for the supervisor to leave `ready` after `process.kill()` — the plan's poll sampled the still-attached dead child on its first tick and passed vacuously. Assertions unchanged; test strictly stronger.
7. Wait budgets raised for busy local machines (assertions unchanged): `e2e/playwright.config.ts` timeout 90 s → 150 s and expect timeout 15 s → 20 s; `waitReady` 30 s → 60 s; `renders 200 stories` count timeout 10 s → 30 s. Investigated first: every failure observed locally correlated with 3–4× suite-time inflation while other IDEs loaded the machine (renderer-reflection and app-launch stalls of 15–90 s that never reproduced in isolation or on fast runs, and left no orphaned processes). CI is unaffected logically — only wait budgets grew.

## Deferrals and scope notes

- FND-12 AC4 (betterleaks corpus) and FND-2 AC2 (external link handling) — deferred per the plan's Global Constraints §6 (approved).
- FND-11 AC5 ("200 cards stay responsive, interaction under 100 ms"): `renders 200 stories` asserts 200 cards render, but no latency measurement exists. Deferred as plan-approved narrowing; measure during Phase 2 UX hardening.
- FND-6 AC2: property coverage scoped to invariants I1–I5 per the plan; I6/I7 have no Phase-1 surface; I8–I10 covered functionally by `job-queue.test.ts` / `workflow-service.test.ts`.
- `orchestrator-stdio.log` is written unredacted (plan-verbatim). Nothing writes secrets to stdio today and an E2E guard now asserts the token never appears in either log file; route the stream through a redacting transform during Phase 2 packaging (with Electron fuses, which the spec's FND-2 description mentions but no AC requires).

## Adversarial review (fresh-eyes agent, 2026-10-18)

Verdict SHIP: no blockers or majors. WorkflowService is the sole status writer in product code; token handling, temp-dir discipline, pin exactness and §21 security posture verified with file:line evidence; no skipped/weakened assertions, no `eslint-disable`, no TODO debris. Minors above were closed out (AGENTS.md test carve-out, token guard test, this note) or explicitly deferred.
