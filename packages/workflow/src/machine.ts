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
