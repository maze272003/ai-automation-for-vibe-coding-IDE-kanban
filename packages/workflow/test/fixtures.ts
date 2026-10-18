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
