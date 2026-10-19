# Plan Feedback Loop: `reject_plan` and `answer_clarifications` (EXE-7 completion)

> Scope: close the EXE-7 acceptance-criteria gap found in the 2026-10-19 review. Supplements
> `2026-10-18-phase-2-autonomous-execution.md` (Task 2, EXE-7 AC 2 and AC 4).

## Goal

Complete the human plan-approval loop (spec D-4): a story in NEW is no longer dead-ended when
the planner asks questions or the user dislikes the plan.

- The planner may return `clarificationQuestions`; a non-empty list moves the story to
  `needs_clarification` and the questions persist as `clarifications` rows.
- `answer_clarifications` (human): all open questions answered in one request → answers persist
  on the plan's clarification rows → `planningStatus='planning'` → the runner re-plans with the
  Q&A included in the prompt.
- `reject_plan` (human, with feedback): the proposed plan is marked `rejected` with
  `rejectionFeedback` → `planningStatus='planning'` → the runner re-plans with the feedback.
- Auto-accept fires only when the plan has zero clarification questions.
- The story-detail plan tab offers Reject-with-feedback (when `plan_proposed`) and a
  clarification answer form (when `needs_clarification`).

## Non-goals

- Partial answers / editing answers later (re-submit all open answers in one request).
- Planner-proposed acceptance criteria acceptance flow (AC-new-*, spec §19.2) — unchanged.
- Board drag mappings for these events (they are not card moves; no `drag.ts` change).
- GitHub/publish events (`approve_publish`, `override_remote_review` stay unavailable).

## Authoritative requirements

- Spec §27 EXE-7 AC 2 ("Questions → needs_clarification; answers → re-plan") and AC 4
  ("Approve → T1. Reject with feedback → re-plan using the feedback").
- Spec §16.2 NEW sub-status flow: `planning → needs_clarification ⇄ planning → plan_proposed`;
  "rejecting a plan returns to planning with feedback".
- Spec §16.3 T1 guard: "All clarifications are answered" (already enforced via
  `openClarifications === 0`).
- Spec §19.2 planner input: "clarification answers" are part of the prompt; the system "never
  invents business rules" to fill gaps.
- Spec §17.2 contracts: `reject_plan{planVersion, feedback}`, `answer_clarifications{planVersion,
  answers[]}` — already defined in `packages/contracts/src/stories.ts` and listed in HUMAN_EVENTS.

## Assumptions (Joe)

- `answer_clarifications` requires every currently-open ordinal, answered in one request, with
  no duplicate or unknown ordinals and non-empty answers; any violation is `GUARD_FAILED`
  naming the offending ordinals (spec T1 demands all answered; partial editing would need row
  mutation semantics we deliberately avoid).
- A plan with open questions keeps `plans.status='proposed'`; its clarification rows carry the
  Q&A (schema already has `clarifications.answer/answeredAt`).
- Rejected plans stay in history (`plans.status='rejected'` + `rejectionFeedback`); re-plans
  create the next version (v2, v3, …), never mutating old rows.
- The re-plan prompt includes: latest rejected plan's feedback, and the latest plan's
  clarification Q&A (questions with answers, if any).
- Re-plan discovery idempotency key must include the next plan version
  (`auto_plan_<story>_<revision>_v<n>`); the current `<story>_<revision>` key would collide
  after the first re-plan and silently enqueue nothing.
- The planner prompt stops forcing `"clarificationQuestions": []`; it instructs the model to ask
  only questions that genuinely block a correct plan (spec: empty-but-needed answers keep the
  story in NEW — the human must answer).

## Shared contracts (frozen by the lead before dispatch)

```ts
// packages/workflow/src/types.ts (seeded by lead; guards by WS-A)
// The seed extends WorkflowEvent, Effect AND EVENT_TYPES (BA condition C1) so the exhaustive
// matrix/property tests pick the new events up automatically.
export type WorkflowEvent = /* existing */ |
  { type: 'reject_plan'; planVersion: number; feedback: string } |
  { type: 'answer_clarifications'; planVersion: number; answers: { ordinal: number; answer: string }[] };

export type Effect = /* existing */ |
  { kind: 'reject_plan'; planVersion: number; feedback: string } |
  // BA condition C2: planVersion (not planId) — PlanEvidence carries no id; applyEffects
  // resolves the row via the plan_ver_uq(storyId, version) unique index, like approve_plan.
  { kind: 'answer_clarifications'; planVersion: number; answers: { ordinal: number; answer: string }[] };

// machine semantics (WS-A):
//   reject_plan: state NEW ∧ planningStatus='plan_proposed' ∧ plan.version=ev.planVersion
//                ∧ plan.status='proposed' ∧ feedback non-empty
//                → patch { planningStatus: 'planning' }, effects [reject_plan]
//   answer_clarifications: state NEW ∧ planningStatus='needs_clarification'
//                ∧ plan.version=ev.planVersion ∧ plan.status='proposed'
//                ∧ answers.length === openClarifications (BA condition C3: the exact ordinal
//                  set — missing/unknown/duplicate, non-empty answers — is validated in
//                  StoryService, which throws GUARD_FAILED naming the ordinals)
//                → patch { planningStatus: 'planning' }, effects [answer_clarifications]
```

## File ownership

| Workstream | Owned files |
|---|---|
| A. State machine | `packages/workflow/src/machine.ts`, `packages/workflow/test/matrix.test.ts`, `packages/workflow/test/guards.test.ts`, `packages/workflow/test/properties.test.ts`, `packages/workflow/test/fixtures.ts` |
| B. Planner | `apps/orchestrator/src/agents/planner.ts`, `apps/orchestrator/test/planner.test.ts` |
| C. Story service + effects | `apps/orchestrator/src/stories/service.ts`, `apps/orchestrator/src/workflow/service.ts`, `apps/orchestrator/test/stories.test.ts`, `apps/orchestrator/test/workflow-service.test.ts` |
| D. Runner re-plan discovery | `apps/orchestrator/src/agents/runner.ts`, `apps/orchestrator/test/runner.test.ts` |
| E. UI plan feedback | `apps/ui/src/components/kanban/terminal-modal.tsx`, `apps/ui/src/lib/transitions.ts`, `apps/ui/src/components/kanban/clarifications-dialog.tsx` (new) |
| F. Integration tests | `apps/orchestrator/test/plan-feedback.test.ts` (new) |
| Lead integration | `packages/workflow/src/types.ts` (contract seed), `apps/orchestrator/src/app.ts` (if wiring needed), final review, plan/report |

No workstream may edit another's files. All files carry uncommitted user/merge-integrity work —
re-read before editing and preserve unrelated hunks; never commit.

## Acceptance criteria

1. A plan with non-empty `clarificationQuestions` → `planningStatus='needs_clarification'`,
   clarification rows persisted (ordinal, question), no auto-accept, story stays NEW.
2. `answer_clarifications` with the full answer set → answers persisted (`answer`, `answeredAt`),
   `planningStatus='planning'`, a re-plan job enqueued (discovery), and the re-plan prompt
   contains the Q&A; a partial, duplicate-ordinal, unknown-ordinal or empty-answer request →
   `GUARD_FAILED` naming the offending ordinals.
3. `reject_plan{planVersion, feedback}` → plan `rejected` with feedback persisted,
   `planningStatus='planning'`, re-plan job enqueued, re-plan prompt contains the feedback;
   rejecting a non-proposed/wrong-version plan → `GUARD_FAILED`.
4. Re-plan produces the next plan version; earlier plans remain untouched; T1 approve still
   works on the new proposal (and is blocked while clarifications are open).
5. The exhaustive machine matrix and property tests cover both events (allowed + denied cases).
6. UI: Reject-with-feedback available when `plan_proposed`; answer form when
   `needs_clarification`; both send `expectedVersion` and surface guard failures. Verification
   this cycle: `npm run typecheck` + `npm run lint` + manual code review (apps/ui has no test
   infrastructure; BA condition C5). A Playwright e2e for both flows is a recorded follow-up.
7. `npm run check:pins && npm run lint && npm run typecheck && npm test` passes on the full
   suite (BA condition C6; no reliance on pre-cycle counts).

## Risks / migration

- No schema migration (all columns exist); no new dependencies.
- Discovery widening (`planningStatus='planning'`) must not re-enqueue while a plan job is
  queued/leased (existing `hasActiveJob` + `activeRunId` guards) and must not loop on
  `planning_failed` (unchanged terminal-ish status).
- `planningStatus` writes remain outside WorkflowService (existing planner pattern); the
  transitions themselves still flow through it — unchanged authority boundary this cycle.

## Follow-up ledger (recorded by the BA review)

- EXE-7 stays PARTIAL after this cycle: AC 3 (two invalid outputs → `planning_failed`) is only
  implemented for runtime failure — `parsePlan` never fails today; AC 6's `autoAcceptPlans`
  project setting is read by no production caller. Both remain on the EXE-7 ledger.
- UI e2e for reject/answer flows (with this cycle's stop/hold controls) is a shared follow-up.

## Outcome (2026-10-19, cycle 2)

Implemented by workstreams A–F plus lead (contract seeding incl. the `TransitionId` extension
after WS-A correctly blocked on the lead-owned gap, and the planner run-key hardening).

- Final gate: `check:pins` ✅, `lint` ✅, `typecheck` ✅, `npm test` **49 files / 577 tests**
  (48/523 at cycle start; +54 tests, zero regressions). QA verdict: **PASS with notes**;
  BA verdict: **accept** (all 7 ACs PASS, BA conditions C1–C6 honored).
- Post-review repairs (attempt 1, verified by targeted suites + full gate):
  - **QA D1**: `answer_clarifications` validation is skipped when the idempotency key was
    already recorded — a crash-window replay returns the duplicate transition, not a guard
    error.
  - **QA D2**: the ordinal validator defers to the machine when `planningStatus` is not
    `needs_clarification`, so stale-tab retries get the clear `planning_status` guard message.
- Recorded follow-ups: UI answer-ordinal derivation from plan content (fragile if partial-answer
  semantics ever land; root fix is the EXE-16 `GET /stories/:id/plans` endpoint), QA
  observations O1–O6 (at-least-once re-plan version drift, prompt Q&A scope after
  edit_definition, unbounded `answers` array, discovery ignoring `hold`), and the shared UI
  e2e backlog item.
