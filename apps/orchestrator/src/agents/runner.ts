// apps/orchestrator/src/agents/runner.ts
import type { BlockedReason } from '@aik/contracts';
import { durableJobs, mergeApprovals, plans, reviews, userStories, verificationRuns, type AikDb } from '@aik/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import type { JobQueue, LeasedJob } from '../jobs/queue.ts';
import { systemClock, type Clock } from '../time.ts';
import type { VerificationRunner } from '../verify/runner.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { LocalMerger } from '../git/merger.ts';
import type { ImplementerAgent } from './implementer.ts';
import type { PlannerAgent } from './planner.ts';
import type { ReviewerAgent } from './reviewer.ts';

export interface AgentRunnerDeps {
  db: AikDb;
  queue: JobQueue;
  workflow: WorkflowService;
  bus: EventBus;
  planner: PlannerAgent;
  implementer: ImplementerAgent;
  verification: VerificationRunner;
  reviewer: ReviewerAgent;
  merger?: LocalMerger;
  now?: Clock;
  pollIntervalMs?: number;
  /** How often a running job handler renews its lease (spec §15, FND-7, I9). */
  heartbeatMs?: number;
}

export class AgentRunner {
  private readonly db: AikDb;
  private readonly queue: JobQueue;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly planner: PlannerAgent;
  private readonly implementer: ImplementerAgent;
  private readonly verification: VerificationRunner;
  private readonly reviewer: ReviewerAgent;
  private readonly merger?: LocalMerger;
  private readonly now: Clock;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;

  private running = false;
  private isTicking = false;
  private unsubscribeBus?: () => void;
  private timer?: NodeJS.Timeout;

  constructor(deps: AgentRunnerDeps) {
    this.db = deps.db;
    this.queue = deps.queue;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.planner = deps.planner;
    this.implementer = deps.implementer;
    this.verification = deps.verification;
    this.reviewer = deps.reviewer;
    this.merger = deps.merger;
    this.now = deps.now ?? systemClock;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.heartbeatMs = deps.heartbeatMs ?? 20_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeBus = this.bus.subscribe(() => {
      void this.triggerTick();
    });
    this.timer = setInterval(() => {
      void this.triggerTick();
    }, this.pollIntervalMs);
    void this.triggerTick();
  }

  stop(): void {
    this.running = false;
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async triggerTick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      await this.tick();
    } finally {
      this.isTicking = false;
    }
  }

  async tick(): Promise<void> {
    this.discoverAndEnqueueJobs();

    let job = this.queue.claim('heavy');
    while (job) {
      const claimed = job;
      try {
        await this.runWithHeartbeat(claimed, () => this.handleJob(claimed));
      } catch (err) {
        this.queue.fail(claimed.id, claimed.leaseToken, err instanceof Error ? err.message : String(err), { retry: false });
      }
      job = this.queue.claim('heavy');
    }
  }

  private discoverAndEnqueueJobs(): void {
    this.discoverPlanning();
    this.discoverImplementation();
    this.discoverVerification();
    this.discoverReview();
  }

  private discoverPlanning(): void {
    // 'none' = first plan; 'planning' = re-plan after reject_plan / answer_clarifications
    // returned the story to planning (spec §16.2). 'planning_failed' and
    // 'needs_clarification' stay out: a failed plan needs a human decision and open
    // clarifications wait for human answers.
    const stories = this.db
      .select({ id: userStories.id, revision: userStories.revision })
      .from(userStories)
      .where(and(eq(userStories.status, 'NEW'), inArray(userStories.planningStatus, ['none', 'planning']), isNull(userStories.cancelledAt), isNull(userStories.activeRunId)))
      .all();

    for (const story of stories) {
      if (!this.hasActiveJob(story.id, 'plan')) {
        // The durable_jobs idempotency key is unique forever (rows are never deleted), so the
        // key must carry the next plan version: a re-plan of the same story+revision under the
        // old `<story>_<revision>` key would collide and silently enqueue nothing. The version
        // is computed exactly like planner.planStory (existing plans + 1) so the key matches
        // the version the planner will save.
        const planCount = this.db.select({ id: plans.id }).from(plans).where(eq(plans.storyId, story.id)).all().length;
        this.queue.enqueue({
          kind: 'plan',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: false,
          idempotencyKey: `auto_plan_${story.id}_${story.revision}_v${planCount + 1}`,
        });
      }
    }
  }

  private discoverImplementation(): void {
    const stories = this.db
      .select({ id: userStories.id, status: userStories.status, statusVersion: userStories.statusVersion, attempts: userStories.attemptCount, maxAttempts: userStories.maxAttempts })
      .from(userStories)
      .where(and(inArray(userStories.status, ['READY', 'REWORK']), isNull(userStories.cancelledAt), isNull(userStories.activeRunId)))
      .all();

    for (const story of stories) {
      if (this.hasActiveJob(story.id, 'implement')) continue;
      if (story.attempts >= story.maxAttempts && story.status !== 'READY') {
        this.block(story.id, 'retry_limit', `Attempt budget exhausted (${story.attempts}/${story.maxAttempts})`);
        continue;
      }
      this.queue.enqueue({
        kind: 'implement',
        slot: 'heavy',
        storyId: story.id,
        sideEffecting: true,
        idempotencyKey: `implement_${story.id}_${story.statusVersion}`,
      });
    }
  }

  private discoverVerification(): void {
    const stories = this.db
      .select({
        id: userStories.id,
        candidateSha: userStories.candidateSha,
        attemptCount: userStories.attemptCount,
        maxAttempts: userStories.maxAttempts,
        activeRunId: userStories.activeRunId,
      })
      .from(userStories)
      .where(and(eq(userStories.status, 'TESTING'), isNull(userStories.cancelledAt), isNull(userStories.activeRunId)))
      .all();

    for (const story of stories) {
      if (!story.candidateSha) continue;
      if (this.hasActiveJob(story.id, 'verify') || this.hasActiveJob(story.id, 'implement')) continue;

      const verification = this.db
        .select()
        .from(verificationRuns)
        .where(and(eq(verificationRuns.storyId, story.id), eq(verificationRuns.commitSha, story.candidateSha), eq(verificationRuns.trigger, 'candidate')))
        .orderBy(desc(verificationRuns.id))
        .limit(1)
        .get();

      if (!verification) {
        this.queue.enqueue({
          kind: 'verify',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: false,
          idempotencyKey: `verify_${story.id}_${story.candidateSha}`,
        });
        continue;
      }

      if (verification.status === 'running') {
        this.queue.enqueue({
          kind: 'verify',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: false,
          idempotencyKey: `verify_${story.id}_${story.candidateSha}_${verification.id}`,
        });
        continue;
      }

      if (verification.status === 'failed' || verification.status === 'error') {
        if (story.attemptCount >= story.maxAttempts) {
          this.block(story.id, 'retry_limit', `Attempt budget exhausted (${story.attemptCount}/${story.maxAttempts}) after failed verification`);
          continue;
        }
        this.queue.enqueue({
          kind: 'implement',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: true,
          idempotencyKey: `rework_verify_${story.id}_${story.candidateSha}_${story.attemptCount}`,
        });
      }
    }
  }

  private discoverReview(): void {
    const stories = this.db
      .select({ id: userStories.id, candidateSha: userStories.candidateSha })
      .from(userStories)
      .where(and(eq(userStories.status, 'READY_FOR_REVIEW'), isNull(userStories.cancelledAt), isNull(userStories.activeRunId)))
      .all();

    for (const story of stories) {
      if (!story.candidateSha) continue;
      if (this.hasActiveJob(story.id, 'review')) continue;
      const existing = this.db
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.storyId, story.id), eq(reviews.commitSha, story.candidateSha)))
        .get();
      if (existing) continue;
      this.queue.enqueue({
        kind: 'review',
        slot: 'heavy',
        storyId: story.id,
        sideEffecting: false,
        idempotencyKey: `review_${story.id}_${story.candidateSha}`,
      });
    }
  }

  private hasActiveJob(storyId: number, kind: 'plan' | 'implement' | 'verify' | 'review'): boolean {
    return !!this.db
      .select({ id: durableJobs.id })
      .from(durableJobs)
      .where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.kind, kind), inArray(durableJobs.status, ['queued', 'leased'])))
      .get();
  }

  /**
   * Lease liveness (spec §15/FND-7, §16.6 I9): renew the lease on an interval while a job
   * handler runs, so handlers longer than the queue's lease (implement runs can take up to
   * ~10 min per spec §18.5 vs a 60 s default lease) do not silently expire. The claim itself
   * is the first renewal; the interval starts with the handler and is always cleared in the
   * finally, so no timer survives between jobs. A heartbeat that reports a lost lease never
   * aborts the handler mid-flight — it only stops renewing and remembers the loss; the loss
   * is enforced afterwards, where complete() reports it (gating follow-up enqueues) and
   * fail() no-ops as 'stale'. Merge jobs additionally re-validate the lease at every
   * state-changing gate via their own assertLease (see handleMergeJob).
   */
  private async runWithHeartbeat(job: LeasedJob, handler: () => Promise<void>): Promise<void> {
    let leaseLost = false;
    const heartbeatTimer = setInterval(() => {
      if (leaseLost) return;
      if (!this.queue.heartbeat(job.id, job.leaseToken)) leaseLost = true;
    }, this.heartbeatMs);
    heartbeatTimer.unref?.();
    try {
      await handler();
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async handleJob(job: LeasedJob): Promise<void> {
    switch (job.kind) {
      case 'plan':
        await this.handlePlanJob(job);
        return;
      case 'implement':
        await this.handleImplementJob(job);
        return;
      case 'verify':
        await this.handleVerifyJob(job);
        return;
      case 'review':
        await this.handleReviewJob(job);
        return;
      case 'merge':
        await this.handleMergeJob(job);
        return;
      default:
        this.queue.complete(job.id, job.leaseToken);
    }
  }

  private async handleMergeJob(job: LeasedJob): Promise<void> {
    if (!job.storyId || !this.merger) {
      this.complete(job);
      return;
    }
    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'AWAITING_MERGE') {
      this.complete(job);
      return;
    }

    // Payload fencing (spec §13.5, S7): the job is stale when its SHA is not the story's current
    // candidate or its approval row no longer exists — complete it without merging and without
    // failing it. Legacy jobs without a fenced payload fall through to the merger's approval guard.
    const payloadSha = typeof job.payload.sha === 'string' ? job.payload.sha : undefined;
    const approvalId = typeof job.payload.approvalId === 'number' ? job.payload.approvalId : undefined;
    if (payloadSha !== undefined && payloadSha !== story.candidateSha) {
      this.complete(job);
      return;
    }
    if (approvalId !== undefined) {
      const approval = this.db
        .select({ id: mergeApprovals.id })
        .from(mergeApprovals)
        .where(
          and(
            eq(mergeApprovals.id, approvalId),
            eq(mergeApprovals.storyId, story.id),
            eq(mergeApprovals.kind, 'merge'),
            ...(payloadSha !== undefined ? [eq(mergeApprovals.commitSha, payloadSha)] : []),
          ),
        )
        .get();
      if (!approval) {
        this.complete(job);
        return;
      }
    }

    // Lease safety (spec §15, I9): renew the lease while the merge runs and let the merger
    // re-validate it at every state-changing gate.
    const assertLease = (): boolean => this.queue.heartbeat(job.id, job.leaseToken);
    const heartbeatTimer = setInterval(() => {
      assertLease();
    }, this.heartbeatMs);
    heartbeatTimer.unref?.();
    try {
      const result = await this.merger.approveAndMergeStory({ storyId: story.id, assertLease });
      if (result.ok) this.complete(job);
      else this.queue.fail(job.id, job.leaseToken, result.error ?? 'Merge failed', { retry: false });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async handlePlanJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.complete(job);
      return;
    }
    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'NEW' || story.cancelledAt) {
      this.complete(job);
      return;
    }

    const result = await this.planner.planStory({ storyId: story.id });
    if (!result.ok) {
      this.queue.fail(job.id, job.leaseToken, result.error ?? 'Plan failed', { retry: false });
      return;
    }
    // I9: a completion that did not land (lease lost mid-handler) must never enqueue
    // follow-up work — another worker owns the story now.
    if (!this.complete(job)) return;
    const updated = this.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
    if (updated?.status === 'READY' && !this.hasActiveJob(updated.id, 'implement')) {
      this.queue.enqueue({
        kind: 'implement',
        slot: 'heavy',
        storyId: updated.id,
        sideEffecting: true,
        idempotencyKey: `implement_${updated.id}_${updated.statusVersion}`,
      });
    }
  }

  private async handleImplementJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.complete(job);
      return;
    }
    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.cancelledAt || !['READY', 'REWORK', 'TESTING'].includes(story.status)) {
      this.complete(job);
      return;
    }

    const result = await this.implementer.implementStory({ storyId: story.id });
    if (result.ok) this.complete(job);
    else this.queue.fail(job.id, job.leaseToken, result.error ?? 'Implementation failed', { retry: false });
  }

  private async handleVerifyJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.complete(job);
      return;
    }
    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'TESTING') {
      this.complete(job);
      return;
    }

    const result = await this.verification.verifyStory({ storyId: story.id });
    if (result.status === 'passed' || result.status === 'failed') {
      this.complete(job);
      return;
    }
    this.queue.fail(job.id, job.leaseToken, result.error ?? 'Verification failed', { retry: false });
    if (result.blockedReason) this.block(story.id, result.blockedReason, result.error ?? 'Verification cannot run');
    else if (story.status === 'TESTING') this.block(story.id, 'environment', result.error ?? 'Verification cannot run');
  }

  private async handleReviewJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.complete(job);
      return;
    }
    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'READY_FOR_REVIEW') {
      this.complete(job);
      return;
    }

    const result = await this.reviewer.reviewStory({ storyId: story.id });
    if (result.ok) this.complete(job);
    else this.queue.fail(job.id, job.leaseToken, result.error ?? 'Review failed', { retry: false });
  }

  /** Complete a job; false means the completion did not land because the lease was lost (I9). */
  private complete(job: LeasedJob): boolean {
    return this.queue.complete(job.id, job.leaseToken);
  }

  private block(storyId: number, reason: BlockedReason, detail: string): void {
    const current = this.db.select({ status: userStories.status }).from(userStories).where(eq(userStories.id, storyId)).get();
    if (!current || !['IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'].includes(current.status)) return;
    this.workflow.transition({ storyId, event: { type: 'fail', reason, detail }, actor: 'system' });
  }
}
