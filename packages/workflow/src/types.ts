import type { BlockedReason, FailedGuard, PlanStatus, PlanningStatus, StoryStatus, Verdict } from '@aik/contracts';

export type TransitionId =
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17'
  | 'EDIT' | 'HOLD' | 'UNHOLD'
  | 'REJECT_PLAN' | 'ANSWER_CLARIFICATIONS';

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
  | { type: 'reject_plan'; planVersion: number; feedback: string }
  | { type: 'answer_clarifications'; planVersion: number; answers: { ordinal: number; answer: string }[] }
  | { type: 'auto_accept_plan'; planVersion: number }
  | { type: 'edit_definition' }
  | { type: 'claim_implement'; runId: number; leaseHeld: boolean; worktreeReady: boolean }
  | { type: 'candidate_committed'; runId: number; candidateSha: string; candidateTree: string; diffEmpty: boolean; treeAlreadyRejected: boolean; protectedPaths?: string[] }
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
  'approve_plan', 'reject_plan', 'answer_clarifications', 'auto_accept_plan', 'edit_definition', 'claim_implement', 'candidate_committed', 'verification_passed',
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
  | { kind: 'reject_plan'; planVersion: number; feedback: string }
  | { kind: 'answer_clarifications'; planVersion: number; answers: { ordinal: number; answer: string }[] }
  | { kind: 'supersede_plan' }
  | { kind: 'interrupt_active_run'; runId: number }
  | { kind: 'cancel_jobs' };

export type TransitionResult =
  | { ok: true; id: TransitionId; from: StoryStatus; to: StoryStatus; patch: StoryPatch; effects: Effect[] }
  | { ok: false; failedGuards: FailedGuard[] };
