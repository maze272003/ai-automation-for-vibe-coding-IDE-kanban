import { durableJobs, userStories, type AikDb } from '@aik/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { EventBus } from '../events/bus.ts';
import type { JobQueue, LeasedJob } from '../jobs/queue.ts';
import { systemClock, type Clock } from '../time.ts';
import type { WorkflowService } from '../workflow/service.ts';
import type { ImplementerAgent } from './implementer.ts';
import type { PlannerAgent } from './planner.ts';

export interface AgentRunnerDeps {
  db: AikDb;
  queue: JobQueue;
  workflow: WorkflowService;
  bus: EventBus;
  planner: PlannerAgent;
  implementer: ImplementerAgent;
  now?: Clock;
  pollIntervalMs?: number;
}

export class AgentRunner {
  private readonly db: AikDb;
  private readonly queue: JobQueue;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly planner: PlannerAgent;
  private readonly implementer: ImplementerAgent;
  private readonly now: Clock;
  private readonly pollIntervalMs: number;

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
    this.now = deps.now ?? systemClock;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
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

    // Initial tick
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
    // 1. Auto-discover stories that need jobs enqueued
    this.discoverAndEnqueueJobs();

    // 2. Claim and process heavy jobs
    let job = this.queue.claim('heavy');
    while (job) {
      try {
        if (job.kind === 'plan') {
          await this.handlePlanJob(job);
        } else if (job.kind === 'implement') {
          await this.handleImplementJob(job);
        } else {
          // Unsupported or external job in heavy slot
          this.queue.complete(job.id, job.leaseToken);
        }
      } catch (err) {
        this.queue.fail(job.id, job.leaseToken, err instanceof Error ? err.message : String(err), { retry: false });
      }

      job = this.queue.claim('heavy');
    }
  }

  private discoverAndEnqueueJobs(): void {
    // Find un-planned stories in NEW
    const newStories = this.db
      .select({ id: userStories.id, revision: userStories.revision })
      .from(userStories)
      .where(
        and(
          eq(userStories.status, 'NEW'),
          eq(userStories.planningStatus, 'none'),
          isNull(userStories.cancelledAt),
          isNull(userStories.activeRunId),
        ),
      )
      .all();

    for (const story of newStories) {
      const activeJob = this.db
        .select({ id: durableJobs.id })
        .from(durableJobs)
        .where(
          and(
            eq(durableJobs.storyId, story.id),
            eq(durableJobs.kind, 'plan'),
            inArray(durableJobs.status, ['queued', 'leased']),
          ),
        )
        .get();

      if (!activeJob) {
        this.queue.enqueue({
          kind: 'plan',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: false,
          idempotencyKey: `auto_plan_${story.id}_${story.revision}`,
        });
      }
    }

    // Find stories ready for implementation in READY
    const readyStories = this.db
      .select({ id: userStories.id, statusVersion: userStories.statusVersion })
      .from(userStories)
      .where(
        and(
          eq(userStories.status, 'READY'),
          isNull(userStories.cancelledAt),
          isNull(userStories.activeRunId),
        ),
      )
      .all();

    for (const story of readyStories) {
      const activeJob = this.db
        .select({ id: durableJobs.id })
        .from(durableJobs)
        .where(
          and(
            eq(durableJobs.storyId, story.id),
            eq(durableJobs.kind, 'implement'),
            inArray(durableJobs.status, ['queued', 'leased']),
          ),
        )
        .get();

      if (!activeJob) {
        this.queue.enqueue({
          kind: 'implement',
          slot: 'heavy',
          storyId: story.id,
          sideEffecting: true,
          idempotencyKey: `auto_implement_${story.id}_${story.statusVersion}`,
        });
      }
    }
  }

  private async handlePlanJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.queue.complete(job.id, job.leaseToken);
      return;
    }

    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'NEW' || story.cancelledAt) {
      this.queue.complete(job.id, job.leaseToken);
      return;
    }

    const result = await this.planner.planStory({ storyId: story.id });
    if (result.ok) {
      this.queue.complete(job.id, job.leaseToken);

      // If story auto-accepted and reached READY, immediately enqueue an implement job
      const updated = this.db.select().from(userStories).where(eq(userStories.id, story.id)).get();
      if (updated && updated.status === 'READY') {
        this.queue.enqueue({
          kind: 'implement',
          slot: 'heavy',
          storyId: updated.id,
          sideEffecting: true,
          idempotencyKey: `implement_${updated.id}_${updated.statusVersion}`,
        });
      }
    } else {
      this.queue.fail(job.id, job.leaseToken, result.error ?? 'Plan failed', { retry: false });
    }
  }

  private async handleImplementJob(job: LeasedJob): Promise<void> {
    if (!job.storyId) {
      this.queue.complete(job.id, job.leaseToken);
      return;
    }

    const story = this.db.select().from(userStories).where(eq(userStories.id, job.storyId)).get();
    if (!story || story.status !== 'READY' || story.cancelledAt) {
      this.queue.complete(job.id, job.leaseToken);
      return;
    }

    const result = await this.implementer.implementStory({ storyId: story.id });
    if (result.ok) {
      this.queue.complete(job.id, job.leaseToken);
    } else {
      this.queue.fail(job.id, job.leaseToken, result.error ?? 'Implementation failed', { retry: false });
    }
  }
}
