# Phase 7 — Autopilot & Visibility — Design

Date: 2026-11-08
Status: REVIEWED rev 11 — **GLM 5.3 spec review round 10: SATISFIED** (0 blocking, 0 major; its one minor applied).
Awaiting user approval and the answer to Q-U1 (§12) before planning.
Inputs: 14-area code recon of `main` @ `be59a54` (2026-11-08); master spec `2026-10-18-autonomous-ai-ide-design.md`; Phase 6 spec `2026-11-07-phase-6-agent-team-claude-codex-design.md`; 3D office spec `2026-11-08-3d-office-design.md`.

## 1. Intent

The app can already plan, code, test, review and merge a story with SHA-bound evidence. What it cannot do yet is
**run without a developer watching it** or **explain itself to someone who is not a developer**. The recon found that
much of the data needed for both is already captured and then dropped, hidden, or never written (cost, story history,
blocked reasons, review comments), and several shipped features are broken or unreachable.

Phase 7 makes the app:

1. **Honest and complete** — fix what is built but broken or unreachable (wave W0).
2. **Readable by everyone** — a developer, an IT lead and a business owner can each open the app and understand, in
   plain words, what is happening, why something is stuck, what shipped and what it cost (W1).
3. **Self-driving** — transient failures heal themselves, work keeps going with the window closed, and the app tells
   people when (and only when) it needs them (W2, W3).
4. **Closed-loop with GitHub** — reviewer comments, CI failures, external merges and issues flow back in (W4).
5. **Fast to feed** — a document becomes a backlog; dependencies and priority drive the order of work (W5).
6. **Unique** — tamper-evident proof-of-done, scheduled work windows, skills learned from successful runs, and the 3D
   office as a control room (W8).
7. **Stay-in-app for developers** — diffs, a persistent terminal and file operations so the developer does not leave
   for VS Code for routine tasks (W7).

## 2. Audience and success

The user said the app serves **developers, the IT industry and business users — all of them** (2026-11-08).

| Person | Today | Success after Phase 7 |
|---|---|---|
| Developer | Babysits blocked stories, leaves the app for diffs, GitHub reviews and terminals | Opens the app only when notified; transient blocks resume themselves; diffs and terminal are in-app |
| IT lead | Cannot audit what the agents did or prove a change was verified | Exports a proof-of-done per story; sees a full timeline; safety rails fail closed |
| Business owner | Sees raw status codes and logs; no cost; no "what shipped" | Reads one plain sentence per story, a weekly shipped report with cost, and gets a notification when a decision is needed |

Phase-level success measures (checked at the end of each wave by the builder against a seeded test project, not by
telemetry — the app collects none):

- S1. Every BLOCKED story shows a plain-English reason and at least one action button that actually performs the
  recovery the hint describes.
- S2. Every finished agent run has a recorded cost (reported, estimated, free, or explicitly unknown).
- S3. A story that is blocked by `quota`, `provider_down` or restart-`interrupted` returns to work without a human once
  the cause clears.
- S4. With the window closed (tray mode on), a story can go from READY to AWAITING_MERGE and the user is notified.

## 3. Goals, non-goals, anti-goals

**Goals:** the work items W0-1 … W8-4 in §6, each with its acceptance criteria.

**Non-goals (explicitly out of Phase 7):**
- N1. Automatic merge approval. The master spec's rule "DONE requires a human merge approval" stands. Nothing in
  Phase 7 writes a merge approval on the human's behalf.
- N2. Cryptographic signing of proof bundles (needs key management). Bundles are tamper-*evident* via digests only.
- N3. Publishing GitHub Releases, branch-protection pre-checks, GitHub webhooks (a local app has no public endpoint).
- N4. Office replay / time-scrubbing, multi-machine or team accounts, telemetry, a full conversational BA agent
  (the Phase 6.3 story chat covers conversation; Phase 7 only adds clarifying questions in backlog intake).
- N5. Language-server code intelligence, multi-file editor tabs, browsing an agent's worktree in the Code tab.
- N6. Finishing Phase 6 (Claude/Codex runtimes, gates, chat). Phase 7 must coexist with it (§4, C7).

**Anti-goals (would make Phase 7 a failure even if it "works"):**
- A1. Any automation that changes story status outside `WorkflowService`, or that hides why it did so. Every automatic
  action writes a `story_events` row with a `system:*` actor and a plain-English reason.
- A2. Automation that loops: every automatic retry/resume has a hard per-story cap and backs off.
- A3. Notifications that nag: a person must never receive more than one notification per story per minute, and
  batching applies (W2-2).
- A4. Leaking code, diffs, logs or secrets off the machine. Outbound webhooks carry only titles, plain-English status
  and links (W2-3).
- A5. Making a business-facing label untrue to the underlying state (e.g. showing "Done" for AWAITING_MERGE).
- A6. Silently weakening an existing rail. Any rail change in this phase only makes it stricter or more visible.

## 4. Constraints

- C1. Repo rules in `AGENTS.md`: exact dependency pins (`npm install -E`); the done-gate is
  `npm run check:pins && npm run lint && npm run typecheck && npm test`; tests only under the OS temp dir via
  `apps/orchestrator/test/helpers/temp.ts`; never log or persist secrets — persisted process/provider output goes
  through the redactor; story status changes only through `WorkflowService`; never import `spikes/`.
- C2. Windows 11 desktop, Electron + React (`apps/ui`) + Node orchestrator (`apps/orchestrator`) + SQLite via drizzle
  (`packages/db`). Build on what exists; no new framework.
- C3. Migrations are hand-written SQL + snapshot + `_journal.json` entry, following the "journal `when` rule" in the
  Phase 6 plan (strictly increasing `when`, contiguous `idx`). Next free number at the time of writing is **0004**.
  Migrations must preserve the append-only triggers from `0001_immutability_triggers.sql`.
- C4. New dependencies only when unavoidable, exact-pinned, and named in the plan. Monaco's diff editor is already
  available through the existing editor dependency.
- C5. Everything runs locally. The only new outbound network targets are (a) GitHub API endpoints the app already
  talks to, plus Issues and Actions-logs endpoints, and (b) user-configured webhook URLs (W2-3).
- C6. Existing tables marked append-only stay append-only. New "derived" data goes in new tables or new nullable columns.
- C7. **Phase 6 coexistence.** Phase 6 is 3/85 tasks done. Phase 7 lands first (my call, §11). Where Phase 7 touches
  the same thing Phase 6 planned, Phase 7 implements the shape the Phase 6 spec already chose, so Phase 6 can build on
  it instead of redoing it:
  - `model_usage` rebuild uses exactly Phase 6 §5.12's column set (W0-1).
  - The story modal tab list added in W1 is a superset the Phase 6.3 story view will extend.
  - The runtime abstraction is not touched; Phase 7 reads usage/cost from OpenCode runs and from the `run.activity`
    `usage` events (which Phase 6's Claude runtime already emits).
- C8. The three test files committed RED by `c2c69fe` for Phase 6 (`packages/contracts/test/agent-team.test.ts`,
  `apps/orchestrator/test/spawn-streaming.test.ts`, `apps/orchestrator/test/agent-env.test.ts`) currently fail
  typecheck, lint and tests on `main`. See open question Q-U1. Until answered, the done-gate for Phase 7 work is the
  four commands with those three files' failures (and only those) tolerated; Phase 7 must not edit them.

## 5. What the user decided

- U1. Audience: developers, IT industry and business users (2026-11-08).
- U2. Scope: "all of the ideas" from the recon summary are in (2026-11-08): the repairs, business visibility,
  developer de-babysitting, and the unique features (proof-of-done, quota-aware scheduling, learned skills, office
  control room).
- U3. This spec is reviewed by GLM 5.3 until the reviewer is satisfied (2026-11-08).

Everything else below is my call unless marked otherwise, and is listed in §11 for checking.

## 6. Design

Each item has an ID, behaviour, data/API, UI, and acceptance criteria (AC). "Story event" means a `story_events` row.
"Plain sentence" means the output of `describeStory()` (W1-2). Settings named `settings.x` live in `ProjectSettings`
(`packages/contracts/src/projects.ts`) unless stated as app settings (`app_settings` table).

### Shared building blocks (used by several waves)

- **B1. `describeStory(input) → { headline, detail?, nextAction? }`** — pure function in `packages/contracts`
  (W1-2). Single source of every plain-English status sentence in cards, modal header, office, notifications,
  webhooks and reports.
- **B2. Event emission.** The orchestrator starts emitting the topics already declared in
  `packages/contracts/src/events.ts` but never sent: `review.completed` (after a review row is written),
  `pr.updated` (when the poller stores a changed PR row), `provider.quota` (when quota state changes).
  `run.output`, `github.connection`, `system.health` stay unsent (not needed). New topic: `usage.recorded` (W0-1).
- **B3. System actor convention.** Automatic actions use actors `system:auto-resume`, `system:watchdog`,
  `system:flaky-retry`, `system:worktree-rescue`, `system:auto-replan`, `system:scheduler`, `github:<login>`.
  Today `WorkflowService`'s `Actor` type is `'human' | 'system' | \`agent:${Role}\`` (`apps/orchestrator/src/workflow/service.ts:17`);
  Phase 7 widens it to also accept `` `system:${string}` `` and `` `github:${string}` `` (`story_events.actor` is
  already free text, so no migration). The UI renders them as "Autopilot" / "GitHub (<login>)".
- **B4. Recovery target mapping (`resumeTargetFor(blockedFrom)`).** Pure function in `packages/workflow`, used by
  both the human Resume button (W1-4) and auto-resume (W3-1), because `recover` to the blocked-from status (T16) is
  only legal for `RESUMABLE_STATUSES` (TESTING, READY_FOR_REVIEW, REWORK, AWAITING_MERGE):
  - blocked from TESTING / READY_FOR_REVIEW / REWORK / AWAITING_MERGE → T16 (back to that status);
  - blocked from IN_PROGRESS or READY → T14 to READY (guard: approved plan for the current revision — true after
    planning). The resumed stage starts a **new** run from the approved plan;
  - blocked from NEW → T15 to NEW (supersedes any proposed plan; planning restarts).
  `extraAttempts` is only sent on T14/T16. Signature:
  `resumeTargetFor(blockedFrom, snapshot, evidence, extra) → target | null`, where `evidence` is the same `Evidence`
  object the machine's `recover` guards evaluate (verification and review for the candidate) and
  `extra = { pr: { state, headSha } | null, mergeReverted: boolean }` is loaded by the caller (stored pull request;
  whether a `merge_reverted` story event exists for the story's succeeded merges row — W3-8). The machine itself needs
  neither. It evaluates
  the target transition's guards against `snapshot`/`evidence`; it returns `null` when they would
  fail (e.g. the story was edited while BLOCKED, so the T14 "approved plan for the current revision" guard is false,
  or T16 evidence no longer holds), and also for the one W4-2 case where the guards pass but resuming can never
  succeed (verified external non-containment: stored PR merged with head ≠ candidate), and after a local Revert Merge
  (W3-8: a `merge_reverted` story event exists for the succeeded merges row). `null` means "resume is not possible — Re-plan instead": W1-4 hides Resume and
  shows Re-plan with that explanation, and W3-1 does not attempt a recover. A test enumerates every status a story
  can be blocked from and asserts that a non-null target is accepted by the machine and a `null` target corresponds
  either to a guard the machine would reject, to the W4-2 verified non-containment case
  (`extra.pr.state === 'merged' && extra.pr.headSha !== snapshot.candidateSha`), or to `extra.mergeReverted`.
- **B5. Structured block cause.** The `fail` workflow event gains an optional `cause`
  (`human_stop | restart | sweep | idle | other`), persisted in a new nullable column `user_stories.blocked_cause`
  (cleared on recover, like `blocked_reason`). Set by: `stop_run` → `human_stop`; the startup interrupted-job sweep in
  `app.ts` → `restart`; the stuck-story integrity sweep → `sweep`; the idle watchdog → `idle`; everything else → `other`.
  W3-1 eligibility for `interrupted` keys off this column, never off `blockedDetail` text.
- **B6. Re-plan feedback carrier.** The `recover` workflow event gains an optional `feedback` (≤ 4000 chars). When
  present with target NEW, a new effect `replan_feedback` writes a story event `replan_feedback { text, source }`
  (`source`: `human` or `reviewer_findings`). The planner's input builder includes, as prior feedback, the latest
  rejected plan's `rejection_feedback` and every `replan_feedback` event newer than the last stored plan.
- **B7. Planning retry budget per round.** Today the planning budget counts every failed planner run the story ever
  had (`failedPlanCount` in `agents/runner.ts` and `failedPlannerRuns` in `agents/stuck-stories.ts`), so after a
  Re-plan the story gets only one more try. Both counters change to count failed planner runs started after the most
  recent *planning reset* story event (`recover` to NEW, or `edit_definition`). The constant stays
  `MAX_PLANNING_ATTEMPTS = 3`.

### W0 — Repairs: built but broken or unreachable

#### W0-1 Cost and usage capture
Today: nothing in production writes `model_usage` or `agent_runs.usage`; the Usage page is always empty; no dollar
figure exists anywhere.

- **Data.** Migration 0004 rebuilds `model_usage` to Phase 6 §5.12's shape: add `runtime text NOT NULL DEFAULT
  'opencode'`, `model_slug text`, `effort text`, `cost_usd real`, `cached_input_tokens integer`, `duration_ms
  integer`; make `model_profile_id`, `http_status`, `latency_ms` nullable (table rebuild; nothing references
  `model_usage`). Phase 7 additionally adds `cost_source text NOT NULL DEFAULT 'unknown'`
  (`reported | estimated | free | unknown`) and `story_id integer REFERENCES user_stories(id)`, `project_id integer
  REFERENCES projects(id)` (denormalised for fast per-project/per-story sums; both nullable for probes).
  `agent_runs.usage` JSON gains optional `cachedInTok`, `costUsd`, `costSource`.
- **Granularity.** One `model_usage` row per finished agent run (any terminal status, including failed, timed out,
  cancelled), `agent_run_id` set. Settings "Test prompt" probes also write a row (`agent_run_id NULL`).
- **Source, in order:**
  1. Cost/tokens reported by the runtime: for OpenCode, summed from the session's assistant messages (see Q-V1); for
     Claude (Phase 6), the final `usage` run-activity event.
  2. If tokens are known but cost is not: estimate `in × inputCost/1e6 + out × outputCost/1e6` from the provider
     catalog (`CatalogModel.inputCost/outputCost`, USD per million tokens) → `cost_source='estimated'`.
  3. Provider `costClass` `local` or `free` → `cost_usd = 0`, `cost_source='free'`.
  4. Otherwise `cost_usd NULL`, `cost_source='unknown'`.
- **Retention.** `model_usage` is never pruned by `maintenance/retention.ts`.
- **API.** `GET /metrics/usage` already accepts `projectId`, `from`, `to` (`api/routes/metrics.ts:8-12`); it gains a
  `storyId` filter and `costUsd` totals per model/project/day.
  `StoryDTO` gains `costUsd` (sum over its runs, null if all unknown) and `costComplete` (false if any run unknown).
- **UI.** Usage page: dollar column and total, project picker (wires the existing `projectId` prop), "estimated"
  marker. Story card/modal show cost (W1). Remove the "(REL-5)" subtitle jargon.
- **AC.** (a) A finished OpenCode run with reported usage writes exactly one row with matching tokens and cost.
  (b) Same run without reported cost but with tokens and a priced model → `estimated` and the correct dollar figure.
  (c) A local model → `free`, 0. (d) Usage page shows non-zero data after one run. (e) Retention leaves rows intact.
  (f) Migration test: populated 0003 DB upgrades with row counts and values preserved and `PRAGMA foreign_key_check`
  empty.

#### W0-2 Project settings page and onboarding
Today: new projects have no checks and no screen to add them, so every story blocks at TESTING; `autoAcceptPlans`
and every other project setting are unreachable from the UI.

- **UI.** Route `/projects/:id/settings` (board header gear + sidebar). Groups: *Verification* (checks table: key,
  command, mandatory, timeout; "Detect checks" fills proposals from `GET /projects/:id/checks/proposal` for review;
  `secretsOnlyVerification`; `cleanroomVerification`; vulnerability scan incl. "scanner found / not found" status),
  *Automation* (`autoAcceptPlans`, `maxAttempts`, W3 settings, W8-2 schedule), *Safety* (`protectedPaths`,
  `shellAllowlist`, `allowPaid`, `allowMayTrain`, `webfetch`), *GitHub* (`publish`, `remoteMerge`,
  `requireRemoteChecks`, `mergeMethod`, W4 settings). Saves via `PATCH /projects/:id` with the full settings object.
  Fields that are not enforced yet (see W0-4) show a "not enforced yet" note instead of pretending.
- **Onboarding.** Board shows a banner while `checks` is empty and `secretsOnlyVerification` is false: "Stories will
  stop at testing until you add checks" → button opens the Verification group with detection already run.
- **AC.** (a) A fresh project can get checks detected, edited and saved without leaving the app. (b) The banner
  disappears after save. (c) Server validation errors are shown inline per field. (d) Every `ProjectSettings` field is
  editable or explicitly read-only with a reason.

#### W0-3 Plan approval and honest plans
- **Approve button** in the plan tab and on the card when `planningStatus='plan_proposed'`: sends the existing
  `approve_plan` transition through `POST /stories/:id/transitions`. Dragging still works.
- **Plan tab shows** assumptions, risks and the acceptance-criterion → verification mapping already in the plan JSON
  (`contracts/src/agents.ts`), complexity, and, for a re-plan, a text diff against the previous rejected plan with its
  rejection feedback.
- **No invented plans.** `planner.ts` `parsePlan` currently fabricates "Implement <title>" when the JSON is invalid.
  Replace with master spec §19.1: inside the same plan job, one corrective follow-up turn in the same session with the
  validation error; if that is still invalid, the job ends with `planning_failed`. This corrective turn does **not**
  count as a planning attempt. The existing outer retry is unchanged: the runner re-plans `planning_failed` stories up
  to `MAX_PLANNING_ATTEMPTS = 3` (`agents/runner.ts:19-24`) and the stuck-story sweep then blocks the story
  (`agents/stuck-stories.ts`). No new transition is added:
  - while outer retries remain, the story shows "The planner's answer was unreadable — retrying (attempt 2 of 3)" and
    offers no button;
  - once blocked (from NEW), the W1-4 panel offers **Re-plan** = `recover` to NEW (T15, per B4), which restarts
    planning with a fresh budget of `MAX_PLANNING_ATTEMPTS` (B7).
- **AC.** (a) Approve button moves the story to READY via WorkflowService (story event actor = user). (b) Invalid
  planner JSON, then invalid again after the corrective turn → `planning_failed`, and no plan row with fabricated
  content exists. (c) Invalid then valid after the corrective turn → a normal proposed plan, planning attempt count
  unchanged. (d) Assumptions/risks render when present. (e) A story blocked after exhausting 3 planning attempts,
  then Re-planned, is retried up to 3 more times before blocking again (B7).

#### W0-4 Safety rails fail closed
- **Vulnerability scanner.** Missing `osv-scanner` or unparseable output → check status `error` (not passed).
  Because the scan is mandatory when enabled, the story blocks with `environment`, `blockedDetail` "osv-scanner not
  found at <path>", hint updated to name both fixes (install it, or turn the scan off in project settings). The
  settings page shows scanner availability before this ever happens.
- **Protected paths.** When a candidate touches `protectedPaths`, work proceeds normally but merge approval requires
  an explicit acknowledgement: the Approve & Merge button is disabled until the user ticks "I reviewed changes to:
  <paths>". The server rejects an approval whose acknowledged path list does not equal the candidate's matched list.
  The acknowledgement is persisted in the approval row itself: `merge_approvals.note` (nullable text, append-only,
  one row per story/kind/commit via `ma_uq`; `packages/db/src/schema.ts:295-305`) stores
  `{"protectedPathsAcknowledged":[...]}` as JSON (any free-text note the user types goes in a `text` field of the same
  JSON). A story event `protected_paths_acknowledged` is also written so the timeline shows it. Both appear in the proof.
- **Shell allowlist.** Empty allowlist = today's behaviour, and the settings page says plainly "Agents may run any
  command". Non-empty = enforced through managed OpenCode's permission configuration (allowlisted patterns `allow`,
  everything else `deny`); a denied command ends the run with `permission_denied` → BLOCKED(`permission_denied`)
  with the command in `blockedDetail`. If Q-V2 shows OpenCode cannot enforce this, the field stays "not enforced yet"
  and the builder records that in the plan rather than half-implementing it.
- **AC.** (a) Scanner missing + lockfile changed → BLOCKED(environment), never passed. (b) Approve without
  acknowledgement is rejected (API test) and the button is disabled (UI test). (c) Allowlist enforced or labelled.

#### W0-5 Skills actually reach the agent
- Verify Q-V3 (does managed OpenCode load `.opencode/skills` with `OPENCODE_DISABLE_PROJECT_CONFIG=1`?). If not,
  deliver skills through the mechanism Q-V3 finds (prompt `skills` field, or inline the SKILL.md bodies into the
  prompt within a 12 KB budget, highest-ranked first).
- `bridge.ts` uses `recommendForRepo(db, { repoRoot, task: title + description, statuses: ['approved'] })` and merges
  the result with the per-role defaults (max 3 total).
- New table `run_skills(agent_run_id, skill_id, unique pair)` records what each run received (feeds W8-3 ratings).
- **AC.** (a) An approved skill matching the story text is delivered and recorded. (b) A test proves the agent-facing
  input contains the skill content (not just its name).

#### W0-6 Unreachable features
- Mount `useGlobalShortcuts` and `ShortcutsDialog` (Phase 5.4 spec behaviour).
- Route `/diagnostics` with sidebar entry; implement the endpoints the page calls (`/diagnostics/health`, `errors`,
  `logs`, `backups`, `backup`) per the Phase 5.4 spec, or remove the parts the 5.4 spec does not define. Settings
  subtitle stays truthful.
- **AC.** Every shortcut in `lib/shortcuts.ts` works or is removed from the list; Diagnostics loads with no 404s.

#### W0-7 Correctness fixes found in recon
- Story modal: "Agent session started" only when a run exists; a check with null exit code renders "(no exit code)".
- Wall-clock timeouts record run status `timed_out` (not `failed`).
- `retention.ts` must not delete failed durable jobs of non-terminal stories (deleting them resets the stage retry
  counter).
- Silent stall: a story resumed from BLOCKED(`reviewer_blocked`) into READY_FOR_REVIEW must be re-queued for review
  (the existing BLOCKED review row must not suppress discovery; the stuck-story sweep must cover it).
- **AC.** One regression test per bullet.

### W1 — Visibility for everyone

#### W1-1 Story brief tab
First tab of the story modal: title, description, acceptance criteria (with met/unmet/unknown from the latest review's
AC results), dependencies (with their status), priority, labels, complexity, cost, attempts `n/max`.
"Edit" opens a form that sends the existing `PATCH /stories/:id`; the server's T2/EDIT rules decide which statuses
allow editing, and the button is disabled with the reason otherwise.
**AC.** Brief reflects the stored story; edit round-trips; a disallowed edit shows the server's reason.

#### W1-2 Plain-English status (`describeStory`)
Pure function (B1) taking status, planning status, blocked reason/detail, hold, active run role + latest activity,
attempts, dependency wait, schedule wait (W8-2), quota wait (W3-1). Returns e.g.:
- READY, deps unmet → "Waiting for SHOP-12 to finish."
- IN_PROGRESS → "The coder is working (attempt 2 of 3) — editing src/cart.ts."
- AWAITING_MERGE → "Ready for your approval — all 5 checks passed, review approved."
- BLOCKED(quota) with auto-resume → "Paused: the model quota ran out. Resumes automatically at 14:05."

Status labels for business readers (raw code available in a tooltip/technical-detail expander):
NEW → "Planning" (or "Needs your answers" / "Plan ready for approval" by planning status), READY → "Queued",
IN_PROGRESS → "Coding", TESTING → "Testing", READY_FOR_REVIEW → "In review", REWORK → "Fixing review notes",
AWAITING_MERGE → "Awaiting approval", BLOCKED → "Needs attention", DONE → "Done", CANCELLED → "Cancelled".
Column headers keep their current names; the sentence appears on cards, the modal header, the office, notifications,
webhooks and reports. Move menu and modal header stop showing raw codes.
**AC.** Table-driven unit tests cover every status × planning status × blocked reason; no output contains a raw enum.

#### W1-3 Story timeline
- `GET /stories/:id/timeline?cursor` merges, newest first: story events (transitions, automation, acknowledgements),
  plan versions (summary, approved_by, rejection feedback), clarification Q&A, agent runs (role, attempt, status,
  exit reason, duration, cost), verification runs (trigger, pass/fail counts, flaky), reviews (verdict, finding
  counts), merge approvals, merges, PR state changes, GitHub review imports (W4-1).
- Each entry: `{ at, kind, actorLabel, sentence, technical? }`. UI tab "History" renders sentences with an expander
  for technical detail.
- **AC.** A story driven through plan → reject → re-plan → code → fail check → rework → approve → merge shows every
  step in order with correct actors.

#### W1-4 Blocked panel with real actions
Shown on BLOCKED cards (compact) and at the top of the modal: plain sentence, `BLOCKED_HINTS` text, `blockedDetail`,
the status it was blocked from, attempts, auto-resume state (W3-1). Actions, each mapped to an existing transition:
- **Resume** → `recover` with the target from `resumeTargetFor(blockedFrom)` (B4). Label says where it goes
  ("Resume testing", "Restart coding from the plan", "Restart planning").
- **Re-plan** → `recover` to NEW (T15) with optional feedback text (B6); planning gets a fresh budget (B7).
- **Grant extra attempts** (1–5) → Resume with `extraAttempts` (shown for `retry_limit`, `no_progress`; only when the
  B4 target is T14/T16).
- **Copy worktree path** (for `conflict`) + "Open terminal here" (W7-2).
`BLOCKED_HINTS` are rewritten so every hint names only actions this panel offers (e.g. `reviewer_blocked`: "Re-plan
with the reviewer's notes, or resume to review again").
`recover`'s `causeResolved` stops being hard-coded: for `quota`, `provider_down`, `auth` it checks provider state; if
unresolved the UI asks "The cause still looks active — resume anyway?" and sends `force: true` (new optional field).
**AC.** For each of the 13 reasons, the panel offers ≥1 working action; `retry_limit` + extra attempts actually runs
again; unresolved cause requires confirmation.

#### W1-5 Merge readiness card
On AWAITING_MERGE (modal top and the PR tab): checks passed n/n (flaky flagged), review verdict + blocking findings,
AC met n/m, diff size (+/− lines, files), attempts used, cost, protected paths touched (W0-4), remote CI state,
"waiting for you since …". Approve & Merge sits on this card.
**AC.** Card values equal the stored evidence for the current candidate SHA.

#### W1-6 Project overview and shipped report
- Project cards on `/`: counts (planning / in progress / needs attention / awaiting approval / done this week),
  spend this week, last activity.
- `GET /reports/shipped?projectId&from&to&format=json|markdown`: done stories (title, key, PR link, merged at,
  cost, attempts), stories needing attention with plain sentences, spend total and by project, cost completeness.
  The markdown groups done stories by label and doubles as **release notes** for a range.
- UI: "Reports" page (sidebar) with range picker (this week / last week / custom), project filter, preview,
  "Copy markdown", "Save as…" (reuses the save-dialog bridge of `diagnostics-export.ts`).
- **AC.** Report for a seeded week lists exactly the stories whose DONE story event falls in the range (by
  `story_events`, which is not pruned), with correct totals.

### W2 — Unattended operation

#### W2-1 Background (tray) mode
- App setting `keepRunningInBackground` (default **off**). When off: closing the last window while agent work is
  running or queued asks once "Keep agents working in the background?" (Yes / Quit / "Don't ask again").
- When on: closing the window hides it; tray icon menu: Open, Pause new work (global: runner starts no new runs;
  in-flight continue), Resume work, Quit (asks if runs are active). Tray tooltip: "3 working · 1 needs you".
- "Pause new work" is a runtime flag (app setting `workPaused`, persisted so it survives restart, shown as a banner in
  the window): the runner claims no new agent-run jobs in any project; in-flight runs, verification, polling and
  merges continue. "Resume work" clears it.
- **AC.** (a) Setting on: closing the window leaves the orchestrator running and a queued story progresses.
  (b) Setting off, agents active: closing the window shows the dialog; "Yes" hides to tray and sets the setting on;
  "Quit" quits with the existing interrupt semantics; "Don't ask again" + Quit never asks again.
  (c) Setting off, nothing active or queued: closing quits with no dialog. (d) Pause: no new run starts while paused
  (runner test), an in-flight run finishes, Resume starts the queued one; the flag survives restart.
  (e) Tray Quit with active runs asks for confirmation.

#### W2-2 Desktop notifications
- Main process subscribes to the event stream already forwarded by `events-forwarder.ts`. Notify on:
  needs-decision (plan proposed while auto-accept is off, clarification requested, AWAITING_MERGE), BLOCKED (after
  auto-resume gave up or for non-auto-resumable reasons), DONE, post-merge failure. Per-kind toggles in Settings
  (default: all on except DONE).
- Body = `describeStory` headline; title = "<KEY>: <story title>". Click focuses the app and opens the story modal.
- Anti-nag (A3): ≤1 per story per 60 s; if >3 notifications are pending within 10 s they collapse into one
  ("4 stories need you") that opens a filtered board. No notification while the window is focused on that story.
- **AC.** Unit tests on the coalescing rules; an e2e (or main-process integration) test fires one notification for a
  BLOCKED transition.

#### W2-3 Outbound webhooks (Slack / Teams / generic)
- App settings list of targets `{ name, kind: 'slack'|'teams'|'generic', events: [...], projectIds?: [] }`. The URL is a
  secret: stored in the OS keyring via the existing provider vault mechanism, never in SQLite or logs, shown masked.
- Payload: story key, title, plain sentence, status label, app deep-link text (no URL scheme in Phase 7), PR URL if
  any. Never code, diffs, logs, findings text or file paths (A4). Text passes through the redactor anyway.
- Optional weekly digest (Monday 09:00 local) posting the shipped report summary (counts, titles, spend) — sent only
  if the app is running then; missed digests are sent at next start if <24 h late, otherwise skipped.
- Delivery via a new durable job kind `webhook` (3 attempts, backoff 30 s / 2 min / 10 min). Last result per target
  visible in Settings with "Send test".
- **AC.** Test send works against a local HTTP test server; a failing target shows the error and never blocks
  workflow; secret never appears in DB, logs or diagnostics export (test greps them).

### W3 — Self-healing automation

All W3 behaviour is per project, configured under *Automation* (W0-2), and every automatic action writes a story event
(A1) and respects a cap (A2).

#### W3-1 Auto-resume transient blocks
- Setting `autoResume: { enabled: true, maxPerStoryPerDay: 3 }`.
- Eligible reasons: `quota`, `provider_down`, and `interrupted` **only** when `blocked_cause` (B5) is `restart` or
  `sweep` (never `human_stop`, `idle` or `other`).
- **Not resumable now.** If `resumeTargetFor` returns `null` (B4) at a scheduled resume, auto-resume stops for this
  block: it writes a story event `auto_resume_stopped { reason }`, the sentence switches to the Re-plan wording, and a
  needs-attention notification fires. No `recover` is sent, so a guard denial can never loop. If a recover is sent and
  still rejected (race with a concurrent edit), the same stop path applies.
- **Quota reset time.** The gateway parses `Retry-After` and common reset headers (`x-ratelimit-reset-requests`,
  `x-ratelimit-reset-tokens`, `anthropic-ratelimit-*-reset`) into `markQuotaExhausted(provider, status, until)`.
  Resume at `until + 0–60 s jitter`; if unknown: 15, 30, 60 min, then hourly.
- **Provider down.** Before resuming, probe the provider (cheapest available call, e.g. model list); backoff 2, 5,
  15, 30 min, then hourly.
- **Interrupted.** Resume on next start once the orchestrator is healthy.
- Resume = `recover` with the B4 target, actor `system:auto-resume`, `extraAttempts: 0` (a transient block that
  consumed an attempt does not get it back automatically). After the daily cap: stays BLOCKED, plain sentence says
  auto-resume gave up, a notification fires (W2-2).
- **Interactions (precedence, highest first):**
  1. **Hold** — a held story is never auto-resumed; the timer keeps running and resume happens at the first check
     after unhold.
  2. **Global pause** (W2-1) and **work windows** (W8-2) do not stop auto-resume itself: the story is recovered on
     time (so the board is honest). Pause and windows gate only the start of **agent runs** (planner, implementer,
     reviewer). So a story resumed into READY/NEW/READY_FOR_REVIEW waits for the window/unpause before its agent run;
     one resumed into TESTING or AWAITING_MERGE proceeds immediately (checks, polling and merges are never gated).
  3. **Provider still exhausted** at resume time (quota `until` moved) → no recover; reschedule to the new `until`
     (does not count against the daily cap).
  A recover counts against `maxPerStoryPerDay` only when it is performed.
- **AC.** Fake-clock tests: (a) quota with `Retry-After: 120` resumes after 120 s via the B4 target (cover a story
  blocked from IN_PROGRESS → READY and one blocked from TESTING → TESTING); (b) cap of 3 holds; (c) a human-stopped
  story is never auto-resumed; (d) a held story is not resumed until unhold; (e) outside a work window the story is
  recovered but no run starts until the window opens.

#### W3-2 Idle watchdog
- Setting `idleTimeoutMin` (default 10, range 3–60). A run with no new message/tool activity for that long is
  interrupted, run status `timed_out`, exit reason `idle`.
- **Mechanism.** The first idle timeout in an agent run is handled *inside the same durable job and the same
  `agent_runs` row*: the session is interrupted, a run-activity entry "Restarted after N min without activity" is
  recorded, and a fresh session is started on the same worktree with the same prompt plus a note that the previous
  session stalled. No transition happens and no attempt is consumed. A second idle in the same run fails the run
  (status `timed_out`, exit reason `idle`) and the story is blocked with `fail(interrupted, cause: idle)` (B5),
  actor `system:watchdog`. The run's wall-clock role timeout still applies across both sessions.
- Office/cards show "No activity for N min" from `idleWarnMin = idleTimeoutMin / 2`.
- The watchdog only measures time while a run is actually executing; a run cannot exist for a held/paused/out-of-window
  story because those gate run *start*, not runs in flight. A human Stop or Hold during a run uses the existing
  interrupt path and never counts as idle.
- An idle-timeout block (second idle) uses reason `interrupted` with payload cause `idle`; it is **not** auto-resumed
  (W3-1 only resumes restart/crash interrupts).
- **AC.** Fake-runtime test with a silent session → interrupted at the threshold and restarted in the same run with no
  transition and the same attempt number; second idle → run `timed_out`/`idle`, story BLOCKED(interrupted,
  `blocked_cause='idle'`) and W3-1 leaves it alone.

#### W3-3 Flaky check re-run
- Setting `checkRetries` (0–2, default 1). A failed (not `error`, not timed-out) check re-runs immediately on the
  same SHA in the same worktree. If a re-run passes, the check result is `passed` with `flaky=true`; both attempts are
  persisted (respecting append-only tables — new rows or a new table, builder's choice).
- A check key flagged flaky ≥3 times in 14 days shows a "flaky" badge in project settings and the merge card.
- **AC.** Fail-then-pass → passed+flaky, story proceeds, evidence shows both runs; fail-fail → rework as today.

#### W3-4 Agent worktree rescue
- Before a run, if the agent-owned story worktree is dirty: snapshot it (`git stash create` → `update-ref
  refs/aik/rescue/<storyKey>/<epoch>`), reset to the expected HEAD, record a story event with the ref name, continue.
  Never applies to the user's main checkout. Rescue refs older than 30 days are pruned by retention.
- **AC.** Dirty worktree → run proceeds; the ref exists and contains the dirty changes.

#### W3-5 Dependency- and priority-aware scheduling
- Already in place (keep): `claim_implement` is guarded by `dependenciesDone` in the machine, and create/patch reject
  dependency cycles with 400 `VALIDATION_FAILED` and the key path (`stories/service.ts` `replaceDependencies`).
- New: runner discovery skips READY stories with any dependency not DONE, so no job is queued and no failed run is
  recorded (today the claim is refused after queuing); `describeStory` says what it waits for. Discovery order:
  priority P0→P3, then board rank, then creation time. Bulk create (W5-1) reuses the same cycle check.
- **AC.** B depends on A: B is never queued or claimed before A is DONE and no failed run is recorded for B; P0
  starts before P2 when both are READY; bulk create with a cycle is rejected with 400.

#### W3-6 Reviewer-blocked auto re-plan
- Setting `autoReplanOnReviewerBlock` (default **off**). When on, BLOCKED(`reviewer_blocked`) → `recover` to NEW with
  `feedback` = the reviewer's blocking findings (titles, file:line, ≤ 4000 chars; B6, `source: reviewer_findings`),
  actor `system:auto-replan`, at most once per story.
- **AC.** On: one automatic re-plan with findings in the planner input; second block stays blocked. Off: no change.

#### W3-7 Leftover worktree cleanup
- Worktree removals refused at merge are retried hourly by maintenance; after 3 failures, Diagnostics lists them with a
  "Remove" action.
- **AC.** A locked worktree removed on a later pass once unlocked.

#### W3-8 Finish half-done merges (all merge methods)
Today, for every merge path (`LocalMerger` → `local_merge`/`local_squash`, `mergeStory` → `github_merge`/
`github_squash`, and W4-2's `github_external`), the `succeeded` merges row is written **before** post-merge
verification. If verification fails (BLOCKED `post_merge_failed`) or the app stops mid-verification (startup sweep →
BLOCKED `interrupted`, `blocked_cause='restart'`), a Resume — human or W3-1 — returns the story to AWAITING_MERGE,
where nothing drives it, and re-clicking Approve & Merge would wrongly re-run the merge (for local merges it takes the
`syncBase` path and recycles the merged commit as a new candidate via T11).
- **Who enqueues.** (1) W4-2's `handleExternalMerge` enqueues it directly after writing the `github_external` row (the
  normal external-merge path — the only verifier for external merges). (2) Runner discovery (not the PR poller, since
  local merges may have no PR) catches every other half-done case. Discovery matches stories with: status
  AWAITING_MERGE, **not held**, a `succeeded` merges row whose `approvedSha` is the candidate and which has **not been
  reverted** (see Revert below), no
  leased `merge` job (`evidence.mergeInProgress` false), and no queued or leased `postmerge_redrive` job for the story
  (same check as the runner's existing `hasActiveJob`). Idempotency key
  `postmerge_redrive_<storyId>_<mergedSha>_<statusVersion>` stays as the cross-restart dedupe; the active-job check
  stops hold/unhold `statusVersion` bumps from queuing duplicates.
- **Job.** First re-reads the story: if it is no longer AWAITING_MERGE, is held, or the row was reverted, the job
  completes without doing anything (like `handleMergeJob`'s stale-job handling). If the newest `postmerge` run for
  `mergedSha` is already `passed` (the merge job lost its lease or crashed after verification but before
  `merge_completed`), it sends `merge_completed` directly without verifying again. Otherwise it runs
  `verifyPostMerge(mergedSha)` in the `<KEY>.post` worktree; if it passes, sends `merge_completed` (all T10 guards are
  satisfied from the existing row); if it fails, `fail(post_merge_failed)` as today. It never writes a merges row and
  never calls `LocalMerger` or `mergeStory`. Because external merges and resumed merges both verify only inside this
  job, and the job is single-flight per story (lane + active-job check), two verifications of one story never overlap.
- **UI and API.** In that state Approve & Merge is hidden and the merge card shows "Already merged — re-checking"; the
  story sentence says the same. The `approve_merge` endpoint itself also refuses (409 "already merged — re-check in
  progress") while an unreverted `succeeded` merges row exists for the candidate SHA, so a stale UI can never enqueue a
  `merge` job that would re-merge or append a `failed` row.
- **Revert** for local merges keeps its existing guard (BLOCKED `post_merge_failed`), so it is offered after a failed
  re-check, never while one is running. A successful revert now writes a story event `merge_reverted { mergeId,
  revertSha }`; W3-8 discovery and the job treat a merges row with such an event as reverted and never re-check it.
  After a revert the W1-4 panel offers only Re-plan and Cancel (Resume is hidden, B4 returns `null` for it), so DONE
  can never be recorded over a reverted base.
- **AC.** (a) Local merge, post-merge check fails → BLOCKED → Resume → re-check passes → DONE, exactly one succeeded
  merges row, `LocalMerger` not invoked again. (b) Crash during post-merge verification of a local merge → startup
  sweep blocks `interrupted`/`restart` → W3-1 auto-resumes → W3-8 finishes it → DONE. (c) Same two cases for
  `github_merge` and `github_squash` (`mergeStory` not called again) and for `github_external`. (d) While a `merge` job
  is leased, no `postmerge_redrive` job is enqueued. (e) Approve & Merge is not offered in the re-check state.
  (f) External merge: exactly one post-merge verification run, inside the job enqueued by `handleExternalMerge`; runner
  discovery enqueues nothing while that job is queued/leased. (g) Hold/unhold in the re-check state → still one job;
  a held story is not re-checked. (h) After Revert → Resume is not offered and discovery never enqueues a re-check; a
  stale job finding the story reverted, held or not AWAITING_MERGE does nothing. (i) Merge job loses its lease (or the
  app crashes) after a passed post-merge run but before `merge_completed` → story reaches DONE (after W3-1 resume in
  the crash case) with exactly one merges row and no second verification run. (j) `approve_merge` in the re-check
  state → 409 and no `merge` job enqueued (API test).

### W4 — GitHub loop closure

#### W4-1 GitHub reviews reach the agent
- The poller fetches PR reviews and review comments (`/pulls/{n}/reviews`, `/pulls/{n}/comments`) newer than the last
  processed ids (stored per PR). A human `CHANGES_REQUESTED` review moves AWAITING_MERGE → REWORK via the existing
  `request_changes` path (T12), actor `github:<login>`, with each comment converted into a review finding (body
  redacted, file/line kept). Plain review comments without a changes-requested review are shown in the timeline only.
- Existing "override review" stays and wins: once a human overrode the GitHub review for the current head SHA, imported
  reviews for that SHA are recorded in the timeline but do not move the story.
- `request_changes` (T12) is guarded by `attemptsRemain`. If no attempts remain, the import instead sends `fail` with
  reason `retry_limit` (AWAITING_MERGE is active, so `fail` is legal), the findings are still stored, and the
  needs-attention notification fires; the W1-4 panel then offers "Grant extra attempts".
- **AC.** Recorded fixture: changes-requested with 2 line comments → REWORK with 2 findings in the implementer input;
  re-poll is idempotent; with attempts exhausted → BLOCKED(retry_limit) with findings stored; after an override for
  the head SHA → no transition.

#### W4-2 External merges
Today `handleExternalMerge` (`github/merge-service.ts`) is only test-called. It writes a `merges` row and runs
post-merge verification inline **before** sending `merge_completed`, whose guard requires a human `merge_approvals`
row for the candidate SHA (master spec guarantee, N1). Wiring it naively would loop on every poll for an unapproved
story. Phase 7 moves its verification step into W3-8's job (see "External merges verify only through W3-8's job").
- **Idempotency.** Note that `mergeStory` already writes `merges` rows for the candidate SHA, including `failed` ones
  on 405/409/network errors. So the poller — and a new early return inside `handleExternalMerge` — skip only when a
  `merges` row for the candidate SHA exists with status `succeeded` or `running`. A `failed` row never suppresses
  external-merge handling.
- **Approved locally, merged on GitHub** (including after a failed Approve & Merge) → call `handleExternalMerge`; the
  story goes DONE as the function defines.
- **Not approved locally** (the normal "someone clicked Merge on github.com" case) → do **not** call it. The story stays
  AWAITING_MERGE with `describeStory` "The PR was merged on GitHub — confirm to finish this story", one needs-decision
  notification fires, and the merge card shows **Confirm GitHub merge**.
- **Confirm** uses a new endpoint `POST /stories/:id/confirm-external-merge { acknowledgedProtectedPaths?, note? }`
  (not `approve_merge`, which would enqueue a `merge` job against an already-merged PR). It writes the human
  `merge_approvals` row for the candidate SHA (kind `merge`, same note/acknowledgement rules as W0-4), enqueues **no**
  merge job, then calls `handleExternalMerge` (which writes the merges row and enqueues the W3-8 job). The endpoint
  returns once the approval and merges rows exist; the story reaches DONE when the job's post-merge checks pass. It is
  refused unless the stored PR state is `merged`. Nothing writes the approval automatically (N1).
- **Poll set.** The background poll loop today queries only `state='open'` PRs (`app.ts:216-224`), which would make
  external-merge handling one-shot. It also includes PRs with `state='merged'` whose story is not DONE/CANCELLED, so
  handling is retried until the story finishes. The unapproved-case notification is emitted once per PR state change
  (open → merged), not per poll; the "merged" state is remembered on the PR row so repeated polls never re-notify.
- **Merged PRs are poll-only-for-state.** For PRs with stored `state='merged'`, a poll updates the stored row (state,
  `mergeCommitSha`, head) and drives external-merge handling only. Head-drift (`candidate_head_changed`, T11), the
  remote-CI rework path and W4-1 review imports apply to `state='open'` PRs only.
- **Containment rule for external merges.** Ancestry alone is wrong for GitHub "Squash and merge" / "Rebase and merge"
  (the PR head is not an ancestor of the resulting commit). An external merge is **contained** when the stored PR
  `state === 'merged'` **and** the stored PR head SHA equals the story's candidate SHA — GitHub guarantees the merge used
  that head, whatever the method. (This matches how the app already treats its own squash merges: tree equality / the
  merges row, not ancestry.) If the merged head SHA differs from the candidate, that is a **verified non-containment**:
  `fail(environment)` with the sentence "The PR was merged with changes that were not the approved version (merged
  <short head>, approved <short candidate>)".
- **Transient vs verified failures.** Today `handleExternalMerge` swallows a failed fetch of the merge commit and then
  reports "does not contain approved candidate" (`merge-service.ts`, fetch + `isAncestor` block). Phase 7 separates
  them: if the merge commit cannot be fetched (it is still needed locally for post-merge verification) or the PR head
  cannot be read, nothing transitions, a `remote_sync_runs` / run-activity entry records the error, and the next poll
  retries (after 5 consecutive failures the story's sentence says "Can't confirm the GitHub merge — check your network"
  and a needs-attention notification fires once). `fail(environment)` is reserved for the verified non-containment
  above.
- **External merges verify only through W3-8's job.** `handleExternalMerge` changes: after the containment rule passes
  it writes the `github_external` `succeeded` merges row and **enqueues** a `postmerge_redrive` job (W3-8) instead of
  running post-merge verification inline. It never verifies itself, so there is exactly one verifier per merge and it
  is crash-safe (the row exists before the job). This applies to both callers: the poller and the Confirm endpoint.
  Resuming a half-finished merge is likewise W3-8's job for every merge method.
- **No overlap with a live merge.** External-merge handling skips a story while its `merge` job is leased
  (`evidence.mergeInProgress`, already computed by `workflow/snapshot.ts`): `mergeStory` marks the row `succeeded` and
  the PR `merged` *before* it runs post-merge verification, and verification uses the fixed `<KEY>.post` worktree.
  Handling is also single-flight per PR (an in-memory per-PR guard), and the poll loop does not start a new cycle while
  the previous one is still running, so overlapping 60 s cycles cannot double-run it.
- **Verified non-containment is not resumable.** After `fail(environment)` for "merged head ≠ candidate", B4 treats the
  block as not resumable (returns `null` while the stored PR is merged with a head different from the candidate), so
  W1-4 shows only Re-plan and Cancel with the "not the approved version" explanation.
- **Exit when post-merge checks keep failing after a GitHub merge.** The existing Revert Merge only works for local
  merges: it needs `merges.baseBefore` (not recorded for `github_*` rows) and only moves the local base ref, never the
  remote. So for any story whose succeeded merges row is `github_external`, `github_merge` or `github_squash`, the
  W1-4 panel hides Revert Merge and says "This was merged on GitHub — revert it there (GitHub's Revert button creates a
  revert PR), then Cancel this story or Re-plan it as a fix". Available actions: Resume (W3-8 re-runs post-merge
  checks), Re-plan (T15, per B4), Cancel (T17). For local merges the panel offers Revert Merge (as today), Resume
  (W3-8), Re-plan and Cancel.
- **AC.** (a) Approved + merged fixture → DONE, exactly one `merges` row after repeated polls. (b) Unapproved + merged
  → stays AWAITING_MERGE, no `merges` row, exactly one notification across repeated polls; Confirm → approval row +
  then (after the W3-8 job passes) DONE, and no `merge` job is enqueued. (c) Post-merge verification runs exactly
  once per handling attempt, always inside a `postmerge_redrive` job and never inline in the poller or the Confirm
  request (once in the happy path; again only after a Resume from `post_merge_failed`). (d) A failed Approve & Merge
  (405 fixture → `failed` merges row) followed by an external merge still reaches DONE via exactly one
  `github_external` row. (e) Confirm on a PR that is not merged → 409, nothing written. (f) Merge-commit fetch fails
  once (fixture) → no transition, next poll succeeds → DONE. (g) Post-merge failure → BLOCKED → Resume → verification
  re-runs on the recorded merge commit → DONE, still exactly one `merges` row; while BLOCKED, repeated polls re-run
  nothing. (h) A merged PR of a non-DONE story stays in the poll set; once the story is DONE it leaves it. (i) A
  squash-merged external PR whose head equals the candidate → DONE. (j) A merged PR whose head differs from the
  candidate → BLOCKED(environment) with the "not the approved version" sentence. (k) A merged PR with failing remote CI
  or a later push to its branch does not trigger T11 or CI rework. (l) After a GitHub merge with failing post-merge
  checks, the panel offers Resume / Re-plan / Cancel and no Revert; Cancel reaches CANCELLED. (m) Re-checks after
  Resume are covered by W3-8's ACs. (n) After the (j) block, the panel offers Re-plan and Cancel only. (o) While a
  `merge` job is leased, polls do nothing for that story (fixture: slow post-merge check spanning several poll cycles →
  exactly one post-merge verification run, story DONE). (p) Two overlapping poll triggers handle a merged PR once.

#### W4-3 CI failure logs
- On remote CI failure, if the GitHub App has Actions read permission: fetch logs of failed jobs, keep the last 200
  lines per job (8 KB cap), redact, append to the rework notes. Without permission: today's behaviour plus a setup
  checklist entry "Grant Actions: read to give agents CI logs".
- **AC.** Fixture logs appear (redacted, truncated) in the rework input; missing permission degrades gracefully.

#### W4-4 Conflict detail and auto base sync
- Merge/sync conflicts record the conflicting file list in rework notes and `blockedDetail`.
- Setting `autoSyncBase` (default **off**): the poller runs the existing sync when an AWAITING_MERGE story's base moved;
  the story re-tests per T11.
- **AC.** Conflict lists files; with auto-sync on, a moved base triggers exactly one sync.

#### W4-5 Import GitHub issues
- Board "Import from GitHub" dialog: open issues of the project's repo, filter by label/assignee/text, multi-select.
  Each issue → story: title, body → description, `- [ ]`/`- [x]` task-list lines → acceptance criteria (if none, the
  user must add at least one in the preview), labels copied.
- New table `story_external_refs(story_id, provider 'github', repo, number, url, unique(provider, repo, number))`.
  Re-importing an imported issue is refused with a link to the story.
- Setting `commentOnIssueWhenDone` (default **off**): on DONE, post a comment with the PR link (needs Issues: write).
- Required permission (Issues: read) added to the GitHub App setup checklist.
- **AC.** Import of 3 fixture issues creates 3 NEW stories with refs; duplicate refused; comment posted only when on.

### W5 — Intake

#### W5-1 Backlog from a document
- Board "Plan a backlog" dialog: paste text or pick a `.md`/`.txt` file (≤ 200 KB).
- Planner model, `decompose` mode, read-only access to the repo for context. Output (JSON-validated, one corrective
  retry): either ≤5 clarifying questions (max 2 rounds) or ≤30 draft stories
  `{ title, description, acceptanceCriteria[], priority, labels[], complexity, dependsOn: [draftIndex] }`.
- Editable preview table: edit, delete, merge two rows, change dependencies. "Create N stories" → new
  `POST /projects/:id/stories/bulk` creating stories + dependencies in one transaction (cycle check), each entering
  NEW with a plan job as today (lanes cap concurrency).
- The decompose run is recorded as an agent run with role `planner` on no story (`storyId` nullable is **not**
  available on `agent_runs` — builder records it via `model_usage` with `agent_run_id NULL`, `project_id` set; see §10).
- **AC.** Fixture document → drafts; bulk create is all-or-nothing; dependencies and priorities persisted.

#### W5-2 Complexity and splitting
- Planner complexity is written to `user_stories.complexity` when a plan is stored.
- XL stories show "Consider splitting"; "Split" runs W5-1 decompose on the story's description + plan subtasks,
  creates the drafts via bulk create, and cancels the original (T17) with a story event linking the new keys.
- **AC.** Complexity persisted; split produces linked stories and a cancelled original.

#### W5-3 Board ordering and dependencies in forms
- Drag within a column changes rank (existing API). Create/edit story forms get a dependency picker.
- **AC.** Rank survives reload; dependency picker writes `story_dependencies`.

#### W5-4 New project from scratch
- "Add project" gains "Create a new repository": folder (empty or non-existent), name, key → `git init -b main`,
  README commit, register project, open settings page (W0-2).
- **AC.** New folder becomes a working project; non-empty folder refused.

### W6 — Quality gates (additions)

- W6-1 Repair prompt includes the last 120 lines (8 KB cap per check) of failing check output instead of 40.
- W6-2 Duration regression warning: if a passing check takes > 2× the median of its last 10 passing runs and > 30 s,
  a non-blocking warning appears in Verification and the merge card.
- W6-3 AC traceability: the merge card and proof bundle show the reviewer's per-criterion results (`review_ac_results`).
- **AC.** One test each.

(Fail-closed rails are W0-4; flaky retry is W3-3.)

### W7 — Stay-in-app for developers

- **W7-1 Diffs.** `GET /projects/:id/git/diff?path&from&to` (working tree vs HEAD, commit vs parent). Git tab: click a
  changed file or a history file → Monaco side-by-side diff. Story Diff tab uses the same viewer instead of raw text.
- **W7-2 Terminal dock.** The terminal becomes a dock available on Board, Code and Git pages of a project, resizable,
  up to 4 tabs per project (8 total), shell picker (cmd, PowerShell, Git Bash when found). Sessions survive page
  changes within the project; closing the project's last page kills them after confirmation if a process is running.
  "Open terminal here" accepts a working directory (used by W1-4 for worktrees, must be inside the project or its
  agent worktrees).
- **W7-3 File operations.** Explorer: new file, new folder, rename, delete (confirm). `.git` and paths outside the repo
  refused server-side.
- **W7-4 Navigation.** Ctrl+P quick open (fuzzy file name), regex toggle in search.
- **W7-5 Git.** Fetch, stash / stash pop (offered when branch switch is refused for uncommitted changes), checkout of a
  remote branch with tracking, conflict list after a conflicted pull (open in editor, "Mark resolved" = stage).
- **AC.** Each sub-item has an API test and a UI test; path-escape attempts rejected (tests).

### W8 — Unique features

#### W8-1 Proof-of-done bundle
- For a DONE story: "Export proof" writes `<KEY>.proof.json` and `<KEY>.proof.md` to a chosen folder. Range export
  (Reports page) writes one pair per story.
- JSON contents: story + AC revision; approved plan; every candidate SHA with its verification runs/checks
  (status, exit code, duration, flaky, SHA-256 of the stored output tail); reviews, findings and AC results; protected
  path acknowledgements; merge approval (actor, time, approved SHA); merge (before/after SHA); post-merge checks; PR
  URL; cost; timeline sentences.
- Tamper evidence: each section carries `sha256` of its canonical JSON (sorted keys, no whitespace); the top-level
  `digest` is the SHA-256 of the concatenated section hashes. A "Verify proof" action (Reports page) recomputes and
  compares against the file and against the DB.
- No secrets or log bodies; only hashes of outputs. Redactor applied to all text fields.
- **AC.** Export → verify passes; edit one byte → verify names the section.

#### W8-2 Work windows and quota-aware scheduling
- Setting `schedule: { mode: 'always' | 'windows', windows: [{ days: [0-6], start: 'HH:MM', end: 'HH:MM' }] }`
  (local time; overnight windows allowed). Outside a window the runner starts no new agent runs for that project;
  in-flight runs finish. Verification, polling and merges are not limited.
- Quota-aware: jobs whose provider is exhausted with a known `until` are deferred to that time instead of starting and
  blocking (W3-1 data).
- Board header shows "Next window 22:00" when outside; `describeStory` says "Scheduled — starts at 22:00".
- **AC.** Fake-clock tests for window edges, overnight windows and quota deferral.

#### W8-3 Skills learned from successful runs
- Setting `learnSkills` (default **off**). When a story reaches DONE with an APPROVED review, a job drafts a SKILL.md
  (model call with the plan, review notes and diff stat — not the full diff) describing a reusable technique, only if
  the model judges one exists (structured `{ worthSaving, name, description, body }`).
- Draft enters the skill vault with source `learned`, status `quarantined`, through the existing scan; never used
  until approved.
- New **Skills page** (sidebar): list vault skills (approved / quarantined / learned), approve/reject, and per-skill
  outcome stats from `run_skills` (runs, success rate = run succeeded and review APPROVED). Recommendation ranking
  (W0-5) boosts skills with ≥5 runs and ≥70 % success.
- **AC.** DONE story with learning on → quarantined draft; approval makes it eligible; stats computed correctly.

#### W8-4 Office as a control room
Amends the 3D office spec's read-only rule (user approved the "act from the office" idea, U2): actions go through the
same API routes as the board, so `WorkflowService` still decides.
- **Cost meter:** per desk (run cost so far from `usage` activity events) and per room (project spend today); handled
  in `state/reduce.ts` (today it drops `usage`).
- **Stuck cues:** "zzz"/pulse when a run is silent ≥ `idleWarnMin` (W3-2).
- **Activity feed:** last 20 activities per room on the code screen.
- **Needs-you beacon:** `/office/snapshot` adds `needsYou: [{ storyId, kind, since }]`; rooms with items glow and
  sort first in the room list; PM desk lists them.
- **Act from the office:** station popover actions Resume / Hold / Unhold / Stop / Approve plan / Open story.
- **Retry counter** on desks (`n/max`), **review findings whiteboard** (from `review.completed`, B2), **AI Ops wall**
  shows provider quota state and failure counts per reason.
- **AC.** Reducer tests for usage/feed/stuck state; snapshot test for `needsYou`; popover actions call the same
  routes as the board (mocked API test).

## 7. Data changes (summary)

All in hand-written migrations starting at 0004 (C3); grouping into files is the builder's call.

| Change | Item |
|---|---|
| Rebuild `model_usage` (Phase 6 §5.12 columns + `cost_source`, `story_id`, `project_id`) | W0-1 |
| `user_stories.blocked_cause` (nullable text) | B5 |
| Workflow: `fail.cause`, `recover.feedback`, effect `replan_feedback`, widened `Actor` type (TS only) | B3, B5, B6 |
| `run_skills(agent_run_id, skill_id)` | W0-5, W8-3 |
| Flaky check attempts persisted (new table or columns, append-only respected) | W3-3 |
| `story_external_refs` | W4-5 |
| Per-PR "last processed review/comment id" (column on `pull_requests` or new table) | W4-1 |
| Protected-path acknowledgement storage (existing column or story event) | W0-4 |
| `ProjectSettings` additions (JSON, no migration): `autoResume`, `idleTimeoutMin`, `checkRetries`, `autoReplanOnReviewerBlock`, `autoSyncBase`, `commentOnIssueWhenDone`, `schedule`, `learnSkills` | W3, W4, W8 |
| App settings: `keepRunningInBackground`, notification toggles, webhook target metadata (URLs in keyring) | W2 |
| New job kinds: `webhook`, `learn_skill`, `postmerge_redrive`, `maintenance_worktree_cleanup` (if not reusing an existing kind) | W2, W8, W3 |
| New event topic `usage.recorded`; start emitting `review.completed`, `pr.updated`, `provider.quota` | B2 |

Every new job kind must be wired in the runner and covered by the existing job-kind wiring test (an unwired kind fails
visibly).

## 8. Security notes

- Webhook URLs are bearer secrets: keyring only, masked in UI, excluded from diagnostics export, never logged (test).
- Webhook payloads: allowlisted fields only (A4); a unit test asserts the payload schema has no free-text field other
  than title and plain sentence.
- GitHub review/CI text and imported issue bodies are untrusted input to agents: redacted, length-capped, and wrapped
  in the prompt as quoted data with an instruction that it is not authoritative over the plan/policy.
- New GitHub permissions (Issues read/write, Actions read) are optional; every feature degrades with a visible note.
- Terminal working directories and file operations are confined to the project repo and its agent worktrees.
- Learned skills follow the existing quarantine → scan → human approve path; no auto-approval.
- Proof bundles contain hashes, not log bodies.

## 9. Delivery order

Each wave gets its own implementation plan (superpowers:writing-plans), in this order. A wave may start when its
predecessors' plans are merged.

1. **W0** Repairs (unblocks honest data for everything else).
2. **W1** Visibility (needs W0-1 cost, W0-3 plan view).
3. **W3** Self-healing (needs W1-2 sentences, W1-4 panel).
4. **W2** Unattended (needs W1-2, W3-1).
5. **W4** GitHub loop closure.
6. **W5** Intake (+ W6 quality additions, small).
7. **W8** Unique features (needs W0-5, W1-3, W3-1).
8. **W7** Stay-in-app IDE.

## 10. Left to the builder

- File/module layout, component structure, exact table/column names not fixed above.
- How flaky attempts are stored (W3-3) and where per-PR processed ids live (W4-1), within C6.
- Exact copy of plain sentences beyond the examples, provided W1-2's AC holds.
- Whether the backlog decompose call (W5-1) is modelled as an agent run (if `agent_runs.story_id` can be made
  nullable safely) or only as a `model_usage` row.
- Visual design of new pages, following the existing Aurora UI.

## 11. Calls I made (for the user to check)

1. Phase 7 lands before the rest of Phase 6; Phase 6's plan is rebased afterwards (C7). It is 3/85 done and its
   migrations need renumbering anyway because `0003` is taken by office rooms.
2. Automatic merge approval is excluded (N1) — it would break the master spec's core guarantee.
3. Background mode, DONE notifications, auto re-plan, auto base sync, issue comments and skill learning default
   **off**; auto-resume and flaky re-run default **on** (they only retry what already failed transiently).
4. A missing vulnerability scanner now blocks (fail closed) instead of passing (W0-4).
5. Protected paths require an acknowledgement at merge, rather than blocking the story outright.
6. Empty shell allowlist keeps today's unrestricted behaviour (labelled), to avoid breaking every project.
7. Cost is recorded per run (not per HTTP request), estimated from catalog prices when the runtime doesn't report it.
8. Proof bundles are digest-based, not signed (N2).
9. Webhook digests only send while the app is running; no cloud relay.

## 12. Open questions

**For the user (answers change what gets built):**
- **Q-U1.** The three Phase-6 RED test files on `main` (C8): leave them failing and tolerate them in the done-gate
  (default), or finish Phase 6 tasks 6.1a-01/03 first so `main` is green?

**To verify before planning (builder spikes; the spec defines the fallback for each):**
- **Q-V1.** Does OpenCode populate per-message tokens and cost on assistant messages? The runtime event type already
  carries `{ inputTokens, cachedInputTokens, outputTokens, costUsd }` (`agents/run-activity.ts:19-21`) and
  `getSessionMessages` exists; check `spikes/spk-1/out/probe-A-messages.json` (read only — never import `spikes/`).
  If absent → W0-1 source 2 (estimate) or 4 (unknown).
- **Q-V2.** The managed OpenCode config today emits only `{ snapshots, provider }` (`apps/desktop/src/main/opencode-server.ts:104-121`).
  Does the isolated server honour a `permission.bash` block added to it? If not → allowlist stays "not enforced yet".
- **Q-V3.** Skills are copied to `<worktree>/.opencode/skills` and only *named* in the prompt (`skills/bridge.ts:120-130`).
  Does managed OpenCode load them under `OPENCODE_DISABLE_PROJECT_CONFIG=1`? If not → inline SKILL.md bodies
  (W0-5 fallback).
- ~~Q-V4~~ answered: `merge_approvals.note` exists (W0-4).

## 13. Changelog

- **rev 11** (GLM 5.3 round 10: **SATISFIED**; round-9 fixes verified, no spurious W3-8 discovery found):
  - MINOR applied: `approve_merge` endpoint refuses with 409 in the re-check state; W3-8 AC (j).

- **rev 10** (GLM 5.3 round 9, NOT SATISFIED → applied; all round-8 fixes verified OK):
  - MAJOR-1: a merge job lost after a passed post-merge run but before `merge_completed` was excluded by W3-8 discovery
    → discovery no longer requires "not passed"; the job sends `merge_completed` directly when the run already passed;
    W3-8 AC (i).
  - MINOR: B4's fourth argument is now `extra = { pr, mergeReverted }`; test contract lists all three `null` cases.

- **rev 9** (GLM 5.3 round 8, NOT SATISFIED → applied; W3-8 verified OK for merge-job-driven paths):
  - MAJOR-1: inline verification in `handleExternalMerge` raced W3-8 discovery → external merges now verify only inside
    the `postmerge_redrive` job that `handleExternalMerge` enqueues; Confirm returns once rows exist; W4-2 ACs (b), (c)
    and W3-8 AC (f).
  - Minors: Revert writes `merge_reverted`, W3-8 skips reverted rows and B4 hides Resume; discovery skips held stories
    and stories with an active redrive job; the job re-reads story state first; W3-8 ACs (g), (h).

- **rev 8** (GLM 5.3 round 7, NOT SATISFIED → applied; round-6 fixes verified OK incl. lease/crash semantics):
  - MAJOR-1: local merges had no re-check after Resume/auto-resume → new W3-8: runner-driven `postmerge_redrive` job for
    every merge method (replaces the poller-based re-drive in W4-2), Approve & Merge hidden in that state; ACs.

- **rev 7** (GLM 5.3 round 6, NOT SATISFIED → applied):
  - MAJOR-1: re-drive could race the live merge job (shared `<KEY>.post` worktree) and overlapping poll cycles → skip
    while `mergeInProgress`, per-PR single-flight, non-overlapping poll loop; ACs (o), (p).
  - MINOR: B4 takes the stored PR `{ state, headSha }` so the non-containment `null` is computable; test contract
    amended.

- **rev 6** (GLM 5.3 round 5, NOT SATISFIED → applied; round-4 fixes verified OK):
  - MAJOR-1: re-drive after post-merge failure covered only `github_external` → now any succeeded `github_*` row while
    AWAITING_MERGE; Approve & Merge hidden in that state; AC (m).
  - MINOR: verified non-containment is not resumable (B4 returns `null`); AC (n).

- **rev 5** (GLM 5.3 round 4, NOT SATISFIED → applied; all round-3 fixes verified OK end to end):
  - MAJOR-1: external squash/rebase merges failed the ancestry check → containment = PR merged + PR head equals
    candidate; head ≠ candidate is the verified non-containment; ACs (i), (j).
  - MAJOR-2: Revert Merge cannot undo GitHub merges → hidden for `github_*` merges; exits are Resume / Re-plan /
    Cancel with an instruction to revert on GitHub; AC (l).
  - Minors: re-drive only while AWAITING_MERGE (not BLOCKED); merged PRs are polled for state only — no T11, CI
    rework or review import; AC (k).

- **rev 4** (GLM 5.3 round 3, NOT SATISFIED → applied; all round-2 fixes verified OK):
  - MAJOR-1: W4-2 could strand a story after a transient fetch failure or a post-merge failure → merged PRs of
    non-DONE stories stay in the poll set; once-per-state-change notification; transient vs verified containment
    failures separated; half-finished external merge re-drives verification + `merge_completed` without a second
    `merges` row; ACs (f)–(h).
  - MINOR: B4 signature takes the machine's `Evidence`.

- **rev 3** (GLM 5.3 round 2, NOT SATISFIED → applied; round-1 fixes verified OK except two partials, both fixed here):
  - MAJOR-1: W4-2 idempotency keyed on `succeeded|running` merges rows only; Confirm via new
    `POST /stories/:id/confirm-external-merge` that writes the approval without enqueuing a merge job; ACs (d), (e).
  - MAJOR-2: planning budget counted lifetime failures → B7 per-round counting; W0-3 AC (e).
  - Minors: B4 now returns `null` when guards would fail and W3-1 stops with a story event (no loops); B5 structured
    `blocked_cause` replaces text matching; W3-2 names the first-idle mechanism (same job, same run, new session);
    B6 feedback carrier for Re-plan and auto-replan.

- **rev 2** (GLM 5.3 round 1, NOT SATISFIED → applied):
  - MAJOR-1: Resume cannot go back into IN_PROGRESS/READY/NEW via T16 → new B4 `resumeTargetFor()` mapping used by
    W1-4 and W3-1; W3-1 ACs cover IN_PROGRESS and TESTING cases; precedence with hold / pause / windows / quota defined.
  - MAJOR-2: external merges without a local approval would loop and violate N1 → W4-2 idempotency, "Confirm GitHub
    merge" flow, ACs.
  - Minors: B3 widens the `Actor` type; W3-5 records existing cycle check (400) and claim guard; W0-1 notes existing
    `projectId` filter; W0-3 corrective turn vs `MAX_PLANNING_ATTEMPTS` and Re-plan mechanism; W4-1 `attemptsRemain`
    fallback and override precedence; W2-1 default-path, pause and tray ACs; W3-2 idle-vs-hold/stop and no
    auto-resume of idle blocks; Q-V4 answered (`merge_approvals.note`), Q-V1–3 narrowed with code evidence.
  - C8 (RED Phase-6 tests vs AGENTS.md done-gate) stays open as Q-U1 for the user; each wave plan must record the
    exact tolerated failures until it is answered.
