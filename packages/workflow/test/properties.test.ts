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
  fc.record({ type: fc.constant('reject_plan' as const), planVersion: fc.integer({ min: 1, max: 2 }), feedback: fc.constantFrom('', 'rethink the approach') }),
  fc.record({
    type: fc.constant('answer_clarifications' as const),
    planVersion: fc.integer({ min: 1, max: 2 }),
    answers: fc.array(fc.record({ ordinal: fc.integer({ min: 1, max: 2 }), answer: fc.constantFrom('', 'an answer') }), { maxLength: 3 }),
  }),
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
