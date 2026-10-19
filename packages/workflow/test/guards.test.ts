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

describe('REJECT_PLAN reject_plan', () => {
  it('keeps the story NEW in planning and records the rejection effect', () => {
    const r = evaluate(story(), evidence(), { type: 'reject_plan', planVersion: 1, feedback: 'Stream the export instead' });
    expect(r).toMatchObject({ ok: true, id: 'REJECT_PLAN', from: 'NEW', to: 'NEW', patch: { status: 'NEW', planningStatus: 'planning' } });
    if (r.ok) expect(r.effects).toEqual([{ kind: 'reject_plan', planVersion: 1, feedback: 'Stream the export instead' }]);
  });
  it('requires plan_proposed, the proposed plan version and non-empty feedback', () => {
    const r = evaluate(
      story({ planningStatus: 'planning' }),
      evidence({ plan: { version: 1, status: 'superseded', storyRevision: 1, openClarifications: 0 } }),
      { type: 'reject_plan', planVersion: 2, feedback: '   ' },
    );
    expect(guards(r)).toEqual(['planning_status', 'plan_version', 'feedback']);
  });
  it('a plan that is not the current proposal is folded into the plan_version guard', () => {
    const r = evaluate(
      story(),
      evidence({ plan: { version: 1, status: 'rejected', storyRevision: 1, openClarifications: 0 } }),
      { type: 'reject_plan', planVersion: 1, feedback: 'Reject it again' },
    );
    expect(guards(r)).toEqual(['plan_version']);
  });
});

describe('ANSWER_CLARIFICATIONS answer_clarifications', () => {
  const twoOpen = () => evidence({ plan: { version: 1, status: 'proposed', storyRevision: 1, openClarifications: 2 } });
  it('keeps the story NEW in planning and records every answer', () => {
    const answers = [{ ordinal: 1, answer: 'CSV and JSON' }, { ordinal: 2, answer: 'No' }];
    const r = evaluate(story({ planningStatus: 'needs_clarification' }), twoOpen(), { type: 'answer_clarifications', planVersion: 1, answers });
    expect(r).toMatchObject({ ok: true, id: 'ANSWER_CLARIFICATIONS', from: 'NEW', to: 'NEW', patch: { status: 'NEW', planningStatus: 'planning' } });
    if (r.ok) expect(r.effects).toEqual([{ kind: 'answer_clarifications', planVersion: 1, answers }]);
  });
  it('requires needs_clarification, the proposed plan version and one answer per open question', () => {
    const r = evaluate(
      story({ planningStatus: 'plan_proposed' }),
      evidence({ plan: { version: 1, status: 'approved', storyRevision: 1, openClarifications: 2 } }),
      { type: 'answer_clarifications', planVersion: 3, answers: [{ ordinal: 1, answer: 'CSV and JSON' }] },
    );
    expect(guards(r)).toEqual(['planning_status', 'plan_version', 'clarifications']);
  });
  it('a missing plan denies on plan_version and clarifications', () => {
    const r = evaluate(story({ planningStatus: 'needs_clarification' }), evidence({ plan: null }), {
      type: 'answer_clarifications', planVersion: 1, answers: [],
    });
    expect(guards(r)).toEqual(['plan_version', 'clarifications']);
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
