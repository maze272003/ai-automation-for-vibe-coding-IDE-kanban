import {
  acceptanceCriteria, clarifications, durableJobs, mergeApprovals, merges, plans, reviewAcResults, reviewFindings, reviews,
  storyDependencies, userStories, verificationChecks, verificationRuns, type AikDbOrTx,
} from '@aik/db';
import type { Evidence, StorySnapshot } from '@aik/workflow';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

export type StoryRow = typeof userStories.$inferSelect;

export function getStoryRow(db: AikDbOrTx, id: number): StoryRow | undefined {
  return db.select().from(userStories).where(eq(userStories.id, id)).get();
}

const count = sql<number>`count(*)`;

/** Loads the story and every piece of evidence the state machine's guards need — straight from the DB. */
export function loadSnapshot(db: AikDbOrTx, storyId: number): { row: StoryRow; story: StorySnapshot; evidence: Evidence } | null {
  const row = getStoryRow(db, storyId);
  if (!row) return null;

  const currentAcs = db
    .select({ id: acceptanceCriteria.id })
    .from(acceptanceCriteria)
    .where(and(eq(acceptanceCriteria.storyId, storyId), isNull(acceptanceCriteria.supersededAt)))
    .all();

  const plan = db.select().from(plans).where(eq(plans.storyId, storyId)).orderBy(desc(plans.version)).limit(1).get();
  const openClarifications = plan
    ? (db.select({ n: count }).from(clarifications).where(and(eq(clarifications.planId, plan.id), isNull(clarifications.answer))).get()?.n ?? 0)
    : 0;

  const deps = db
    .select({ status: userStories.status })
    .from(storyDependencies)
    .innerJoin(userStories, eq(userStories.id, storyDependencies.dependsOnStoryId))
    .where(eq(storyDependencies.storyId, storyId))
    .all();

  const mergeJob = db
    .select({ id: durableJobs.id })
    .from(durableJobs)
    .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.kind, 'merge'), eq(durableJobs.status, 'leased')))
    .get();

  const cand = row.candidateSha;
  let verification: Evidence['verification'] = null;
  let review: Evidence['review'] = null;
  let mergeApprovalForCandidate = false;
  let merge: Evidence['merge'] = null;
  let postMergeVerificationPassed = false;

  if (cand) {
    const vr = db
      .select()
      .from(verificationRuns)
      .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, cand), eq(verificationRuns.trigger, 'candidate'), inArray(verificationRuns.status, ['passed', 'failed', 'error'])))
      .orderBy(desc(verificationRuns.id))
      .limit(1)
      .get();
    if (vr) {
      const mandatory = db
        .select({ status: verificationChecks.status })
        .from(verificationChecks)
        .where(and(eq(verificationChecks.verificationRunId, vr.id), eq(verificationChecks.mandatory, true)))
        .all();
      verification = {
        sha: cand,
        mandatoryAllPassed: vr.status === 'passed' && mandatory.length > 0 && mandatory.every((c) => c.status === 'passed'),
      };
    }

    const rv = db
      .select()
      .from(reviews)
      .where(and(eq(reviews.storyId, storyId), eq(reviews.commitSha, cand), eq(reviews.actor, 'agent')))
      .orderBy(desc(reviews.id))
      .limit(1)
      .get();
    if (rv) {
      const blocking = db
        .select({ n: count })
        .from(reviewFindings)
        .where(and(eq(reviewFindings.reviewId, rv.id), eq(reviewFindings.blocking, true), isNull(reviewFindings.priorFindingId)))
        .get()?.n ?? 0;
      const met = new Set(
        db.select({ id: reviewAcResults.acceptanceCriterionId }).from(reviewAcResults)
          .where(and(eq(reviewAcResults.reviewId, rv.id), eq(reviewAcResults.status, 'met'))).all().map((r) => r.id),
      );
      review = { sha: cand, verdict: rv.verdict, blockingFindings: blocking, allAcMet: currentAcs.length > 0 && currentAcs.every((a) => met.has(a.id)) };
    }

    mergeApprovalForCandidate = !!db
      .select({ id: mergeApprovals.id })
      .from(mergeApprovals)
      .where(and(eq(mergeApprovals.storyId, storyId), eq(mergeApprovals.kind, 'merge'), eq(mergeApprovals.commitSha, cand)))
      .get();

    const m = db.select().from(merges).where(and(eq(merges.storyId, storyId), eq(merges.approvedSha, cand))).orderBy(desc(merges.id)).limit(1).get();
    if (m) {
      // The merge job verifies that merged_sha contains the candidate before it records status 'succeeded'.
      merge = { succeeded: m.status === 'succeeded', mergedSha: m.mergedSha, containsCandidate: m.status === 'succeeded' };
      if (m.mergedSha) {
        postMergeVerificationPassed = !!db
          .select({ id: verificationRuns.id })
          .from(verificationRuns)
          .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, m.mergedSha), eq(verificationRuns.trigger, 'postmerge'), eq(verificationRuns.status, 'passed')))
          .get();
      }
    }
  }

  return {
    row,
    story: {
      status: row.status,
      planningStatus: row.planningStatus,
      hold: row.hold,
      revision: row.revision,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      candidateSha: row.candidateSha,
      candidateTree: row.candidateTree,
      blockedFrom: row.blockedFrom,
      blockedReason: row.blockedReason,
      activeRunId: row.activeRunId,
      title: row.title,
      description: row.description,
      currentAcceptanceCriteria: currentAcs.length,
    },
    evidence: {
      plan: plan ? { version: plan.version, status: plan.status, storyRevision: plan.storyRevision, openClarifications } : null,
      dependenciesDone: deps.every((d) => d.status === 'DONE'),
      mergeInProgress: !!mergeJob,
      verification,
      review,
      mergeApprovalForCandidate,
      merge,
      postMergeVerificationPassed,
    },
  };
}
