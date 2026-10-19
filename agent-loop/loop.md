# Loop --- Continuous Think, Plan, Implement, Verify

## Purpose

Run repeated improvement cycles that reconsider the current codebase
using repository evidence. "Think again" means re-evaluate findings and
verify assumptions---not repeat the same analysis endlessly or make
changes without a stopping rule.

## Cycle controller

Repeat the following cycle until the user stops the workflow, the
execution budget is reached, or no safe high-value task remains.

### Phase 1 --- Orient and protect

1.  Read `index.md`, `guard.md`, `planner.md`, `ba.md`, `astral.md`, and
    `joe.md`.
2.  Check Git status and preserve all pre-existing user changes. Never
    discard or reset work merely to get a clean tree.
3.  Identify the current branch, project instructions, relevant
    `superpowers/` specifications, installed skills, and test commands.
4.  Establish or refresh the baseline. Separate pre-existing failures
    from failures introduced by this cycle.

### Phase 2 --- Think and discover

1.  Ask `planner.md` to inspect the repository and use the installed
    Claude `/brainstorming` skill if available.
2.  Identify missing features, incomplete user flows, broken states,
    edge cases, accessibility issues, reliability risks, performance
    bottlenecks, security concerns, maintainability issues, and missing
    tests.
3.  Use code, tests, schemas, API contracts, UI behavior, logs, and
    specification documents as evidence. Do not treat guesses as
    confirmed defects.
4.  Ask `ba.md` to map each candidate improvement to the applicable
    requirement/specification and acceptance criteria.
5.  Ask `joe.md` to resolve ordinary unanswered product and
    implementation questions using repository evidence and conservative
    assumptions.

### Phase 3 --- Rank and select

Create or update a prioritized backlog. Score each candidate on: -
User/business impact - Severity and likelihood - Requirement
importance - Confidence in evidence - Effort and dependency cost -
Security/privacy risk

Prioritize in this order unless evidence justifies otherwise: 1.
Security vulnerabilities, data-loss risks, and broken critical
workflows. 2. Explicit requirements that are unmet. 3. Correctness and
data integrity. 4. High-impact usability/accessibility defects. 5.
Reliability, performance, and observability. 6. Maintainability and
developer experience. 7. Optional enhancements.

Select one coherent task or a tightly coupled set that can be verified
together. Do not implement every idea discovered in a single cycle.

### Phase 4 --- Plan before editing

1.  Write a short plan with goal, non-goals, affected areas,
    dependencies, risks, migration implications, and acceptance
    criteria.
2.  Obtain BA traceability review before implementation.
3.  Assign work to `astral.md`. Split work by independent modules/files
    and define file ownership to prevent concurrent edit conflicts.
4.  If requirements conflict or evidence is insufficient, use `joe.md`
    to choose a conservative reversible assumption. Record uncertainty
    explicitly.

### Phase 5 --- Implement safely

1.  Follow `astral.md` and `guard.md`.
2.  Make small, coherent changes. Avoid unrelated refactors.
3.  Do not have multiple agents edit the same file concurrently. Use a
    lead integrator to review and merge agent work.
4.  Add or update tests alongside implementation.
5.  Do not suppress tests, disable lint rules broadly, weaken
    authorization, or alter expected behavior just to achieve a green
    check.

### Phase 6 --- Verify independently

1.  Run targeted unit tests, integration tests, type checks, lint, and
    build checks as applicable.
2.  Ask the QA agent to review behavior independently from the
    implementation agent.
3.  Ask BA to compare the implementation with the relevant
    `superpowers/` specification and acceptance criteria.
4.  Review the diff for accidental changes, unsafe commands, secrets,
    missing error handling, race conditions, and regressions.
5.  If verification fails, return to implementation with a concrete
    failure report. Limit automatic rework attempts to three focused
    attempts per defect; after that, document the blocker and select
    another safe task.

### Phase 7 --- Reflect and continue

Before ending the cycle, answer: - What did the evidence confirm? -
Which requirement or quality gap was closed? - What remains
incomplete? - Did this change reveal a deeper dependency or new risk? -
What is the highest-value next task?

Update the backlog and cycle notes. Begin another cycle only when a
distinct, evidence-backed task is available.

## Stop conditions

Stop and report when: - The user requests a stop. - No safe, meaningful,
evidence-backed task remains. - A required credential, permission,
external account action, destructive operation, or irreversible decision
requires human authorization. - The repository is unavailable or the
environment prevents meaningful verification. - Three focused repair
attempts fail for the same issue. - The configured time, token, cost, or
iteration budget is reached.

Never create an infinite busy loop, repeatedly run the same checks
without a code change, or claim that continuous work is happening after
the agent process has ended.

## Cycle report template

-   Cycle number:
-   Selected task:
-   Evidence:
-   Requirement/spec reference:
-   Changes made:
-   Tests/checks run:
-   Results and pre-existing failures:
-   Security/privacy review:
-   Remaining risks:
-   Next highest-value task:
