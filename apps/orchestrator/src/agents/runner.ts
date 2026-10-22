import { ProjectSettings, type BlockedReason } from '@aik/contracts';
import { durableJobs, mergeApprovals, plans, projects, reviews, userStories, verificationRuns, agentRuns, type AikDb } from '@aik/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import { heavyLane } from '../jobs/lane.ts';
import type { JobQueue, LeasedJob } from '../jobs/queue.ts';
import { systemClock, type Clock } from '../time.ts';
import type { VerificationRunner } from '../verify/runner.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { LocalMerger } from '../git/merger.ts';
import type { GitHubMergeService } from '../github/merge-service.ts';
import type { ImplementerAgent } from './implementer.ts';
import type { PlannerAgent } from './planner.ts';
import type { ReviewerAgent } from './reviewer.ts';

/**
 * How many times a story may fail planning before the runner stops retrying it. A failed plan
 * used to leave the story parked in NEW/planning_failed forever (the only recovery path needs
 * BLOCKED), which silently stalled the board; the retry is bounded so a permanently broken
 * story still ends up waiting for a human.
 */
const MAX_PLANNING_ATTEMPTS = 3;

/**
 * How many lanes may run a heavy job at the same time. Each lane is one repository, so this is
 * how many repositories can be worked on in parallel (spec ADV-1). The cap keeps a single
 * machine from running more model sessions and test suites at once than it can carry.
 */
const DEFAULT_MAX_CONCURRENT_LANES = 3;

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
  remoteMerger?: GitHubMergeService;
  now?: Clock;
  pollIntervalMs?: number;
  /** How often a running job handler renews its lease (spec §15, FND-7, I9). */
  heartbeatMs?: number;
  /** How many lanes may run a heavy job at the same time (spec ADV-1: parallel projects). */
  maxConcurrentLanes?: number;
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
  private readonly remoteMerger?: GitHubMergeService;
  private readonly now: Clock;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly maxConcurrentLanes: number;

  private running = false;
  private isTicking = false;
  private unsubscribeBus?: () => void;
  private timer?: NodeJS.Timeout;
  /** The heavy jobs currently running, keyed by their lane (one job per lane). */
  private readonly inFlight = new Map<string, Promise<void>>();

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
    this.remoteMerger = deps.remoteMerger;
    this.now = deps.now ?? systemClock;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.heartbeatMs = deps.heartbeatMs ?? 20_000;
    this.maxConcurrentLanes = deps.maxConcurrentLanes ?? DEFAULT_MAX_CONCURRENT_LANES;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.migrateLegacyLanes();
    this.unsubscribeBus = this.bus.subscribe(() => {
      void this.triggerTick();
    });
    this.timer = setInterval(() => {
      void this.triggerTick();
    }, this.pollIntervalMs);
    void this.triggerTick();
  }

  /**
   * Moves jobs that were queued in the old global `heavy` slot into the lane of their
   * repository, so a repository never ends up with one legacy job and one lane job running at
   * the same time. One-time, idempotent: jobs that already sit in a lane are left alone.
   */
  private migrateLegacyLanes(): void {
    const jobs = this.db
      .select({ id: durableJobs.id, storyId: durableJobs.storyId })
      .from(durableJobs)
      .where(and(eq(durableJobs.slot, 'heavy'), inArray(durableJobs.status, ['queued', 'leased'])))
      .all();
    for (const job of jobs) {
      if (job.storyId === null) continue;
      this.db
        .update(durableJobs)
        .set({ slot: this.laneForStory(job.storyId), updatedAt: new Date(this.now()) })
        .where(eq(durableJobs.id, job.id))
        .run();
    }
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

  /**
   * Discovers work and starts one job per free lane.
   *
   * The jobs run in the background: a tick must not wait for a 10-minute implementation run,
   * or no other project could start while it runs. Each lane keeps at most one job at a time,
   * and different lanes (one per repository) run in parallel (spec ADV-1).
   */
  async tick(): Promise<void> {
    this.discoverAndEnqueueJobs();
    this.startJobs();
  }

  /** Awaits the jobs this runner started. Used by the tests and by a graceful shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /** Starts one job per lane that has queued work and no running job. */
  private startJobs(): void {
    for (const lane of this.lanesWithWork()) {
      if (this.inFlight.size >= this.maxConcurrentLanes) break;
      if (this.inFlight.has(lane)) continue;
      const job = this.queue.claim(lane);
      if (!job) continue;
      const claimed = job;
      const promise = this.runWithHeartbeat(claimed, () => this.handleJob(claimed))
        .catch((err) => {
          try {
            this.queue.fail(claimed.id, claimed.leaseToken, err instanceof Error ? err.message : String(err), { retry: false });
          } catch {
            // The database may already be closed (shutdown); the lease expires and the startup
            // sweep reports the job as interrupted.
          }
        })
        .finally(() => {
          this.inFlight.delete(lane);
          // The lane is free again: let the next job in it start right away.
          this.bus.notify(1);
        })
        .catch(() => undefined);
      this.inFlight.set(lane, promise);
    }
  }

  /** The lanes that have queued work: one per repository, plus the shared base lanes. */
  private lanesWithWork(): string[] {
    // Oldest work first, so a lane never starves behind a newer one when the concurrency cap
    // is reached.
    const rows = this.db
      .select({ slot: durableJobs.slot, runAfter: durableJobs.runAfter, id: durableJobs.id })
      .from(durableJobs)
      .where(eq(durableJobs.status, 'queued'))
      .all()
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.id - b.id);
    return [...new Set(rows.map((r) => r.slot))];
  }

  private discoverAndEnqueueJobs(): void {
    this.discoverPlanning();
    this.discoverImplementation();
    this.discoverVerification();
    this.discoverReview();
  }

  private discoverPlanning(): void {
    // 'none' = first plan; 'planning' = re-plan after reject_plan / answer_clarifications
    // returned the story to planning (spec §16.2). 'planning_failed' is retried while the
    // planning budget lasts: a failed plan used to park the story forever, because the only
    // recovery path (`recover`) needs BLOCKED while a failed plan leaves the story in NEW.
    // 'needs_clarification' stays out: open clarifications wait for human answers.
    const stories = this.db
      .select({ id: userStories.id, revision: userStories.revision, planningStatus: userStories.planningStatus, repoPath: projects.repoPath })
      .from(userStories)
      .innerJoin(projects, eq(projects.id, userStories.projectId))
      .where(and(eq(userStories.status, 'NEW'), inArray(userStories.planningStatus, ['none', 'planning', 'planning_failed']), isNull(userStories.cancelledAt), isNull(userStories.activeRunId)))
      .all();

    for (const story of stories) {
      if (this.hasActiveJob(story.id, 'plan')) continue;
      // The durable_jobs idempotency key is unique forever (rows are never deleted), so the
      // key must carry the next plan version: a re-plan of the same story+revision under the
      // old `<story>_<revision>` key would collide and silently enqueue nothing. The version
      // is computed exactly like planner.planStory (existing plans + 1) so the key matches
      // the version the planner will save. The failed-plan counter is part of the key too, so
      // a retry after a failed plan is a new job instead of a no-op on the failed one.
      const planCount = this.db.select({ id: plans.id }).from(plans).where(eq(plans.storyId, story.id)).all().length;
      const failedPlans = story.planningStatus === 'planning_failed' ? this.failedPlanCount(story.id) : 0;
      if (failedPlans >= MAX_PLANNING_ATTEMPTS) continue;
      this.queue.enqueue({
        kind: 'plan',
        slot: heavyLane(story.repoPath),
        storyId: story.id,
        sideEffecting: false,
        idempotencyKey: `auto_plan_${story.id}_${story.revision}_v${planCount + 1}_a${failedPlans}`,
      });
    }
  }

  /** How many planner runs for this story ended in failure (the planning retry budget). */
  private failedPlanCount(storyId: number): number {
    return this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.storyId, storyId), eq(agentRuns.role, 'planner'), eq(agentRuns.status, 'failed')))
      .all().length;
  }

  private discoverImplementation(): void {
    const stories = this.db
      .select({ id: userStories.id, status: userStories.status, statusVersion: userStories.statusVersion, attempts: userStories.attemptCount, maxAttempts: userStories.maxAttempts, repoPath: projects.repoPath })
      .from(userStories)
      .innerJoin(projects, eq(projects.id, userStories.projectId))
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
        slot: heavyLane(story.repoPath),
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
        repoPath: projects.repoPath,
      })
      .from(userStories)
      .innerJoin(projects, eq(projects.id, userStories.projectId))
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
          slot: heavyLane(story.repoPath),
          storyId: story.id,
          sideEffecting: false,
          idempotencyKey: `verify_${story.id}_${story.candidateSha}`,
        });
        continue;
      }

      if (verification.status === 'running') {
        this.queue.enqueue({
          kind: 'verify',
          slot: heavyLane(story.repoPath),
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
          slot: heavyLane(story.repoPath),
          storyId: story.id,
          sideEffecting: true,
          idempotencyKey: `rework_verify_${story.id}_${story.candidateSha}_${story.attemptCount}`,
        });
      }
    }
  }

  private discoverReview(): void {
    const stories = this.db
      .select({ id: userStories.id, candidateSha: userStories.candidateSha, repoPath: projects.repoPath })
      .from(userStories)
      .innerJoin(projects, eq(projects.id, userStories.projectId))
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
        slot: heavyLane(story.repoPath),
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
      const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
      const settings = project ? ProjectSettings.parse(project.settings) : null;
      let result: { ok: boolean; error?: string };
      if (settings?.publish && settings?.remoteMerge && this.remoteMerger) {
        result = await this.remoteMerger.mergeStory(story.id, { method: settings.mergeMethod });
      } else if (this.merger) {
        result = await this.merger.approveAndMergeStory({ storyId: story.id, assertLease });
      } else {
        result = { ok: false, error: 'No merger configured' };
      }
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
        slot: this.laneForStory(updated.id),
        storyId: updated.id,
        sideEffecting: true,
        idempotencyKey: `implement_${updated.id}_${updated.statusVersion}`,
      });
    }
  }

  /** The heavy lane of a story: the lane of the repository its project points at. */
  private laneForStory(storyId: number): string {
    const row = this.db
      .select({ repoPath: projects.repoPath })
      .from(userStories)
      .innerJoin(projects, eq(projects.id, userStories.projectId))
      .where(eq(userStories.id, storyId))
      .get();
    return heavyLane(row?.repoPath ?? '');
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
