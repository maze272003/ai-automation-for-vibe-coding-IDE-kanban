import {
  acceptanceCriteria, clarifications, durableJobs, mergeApprovals, merges, plans, reviewAcResults, reviewFindings, reviews,
  storyDependencies, userStories, verificationChecks, verificationRuns, type AikDbOrTx,
} from '@aik/db';
import type { Evidence, StorySnapshot } from '@aik/workflow';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

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

  // A merge is in progress only while a job actually holds a live lease; an expired lease means
  // the runner lost the job, so the story's escape hatches (cancel/stop/request_changes) must work.
  const mergeJob = db
    .select({ id: durableJobs.id })
    .from(durableJobs)
    .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.kind, 'merge'), eq(durableJobs.status, 'leased'), gt(durableJobs.leaseExpiresAt, new Date())))
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
      // The merger proves containment (tree equality, plus ancestry for merge commits) before it
      // records status 'succeeded' with baseAfter === mergedSha; the snapshot never re-derives it.
      const succeeded = m.status === 'succeeded' && m.mergedSha !== null && m.baseAfter === m.mergedSha;
      merge = { succeeded, mergedSha: m.mergedSha, containsCandidate: succeeded };
      if (m.mergedSha) {
        // T10/I1: a passed run alone is not evidence — mandatory check rows must exist and all pass.
        // The newest post-merge run wins whatever its status, so a later failed/error run at the
        // same SHA can never be masked by an older passed one.
        const pm = db
          .select({ id: verificationRuns.id, status: verificationRuns.status })
          .from(verificationRuns)
          .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, m.mergedSha), eq(verificationRuns.trigger, 'postmerge')))
          .orderBy(desc(verificationRuns.id))
          .limit(1)
          .get();
        if (pm?.status === 'passed') {
          const mandatory = db
            .select({ status: verificationChecks.status })
            .from(verificationChecks)
            .where(and(eq(verificationChecks.verificationRunId, pm.id), eq(verificationChecks.mandatory, true)))
            .all();
          postMergeVerificationPassed = mandatory.length > 0 && mandatory.every((c) => c.status === 'passed');
        }
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
