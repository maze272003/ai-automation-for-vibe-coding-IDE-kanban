import {
  STORY_STATUS, type CreateStoryRequest, type PatchStoryRequest, type PlanV1, type PullRequestDTO, type StoryDTO, type StoryListQuery, type StoryStatus, type TransitionRequest,
} from '@aik/contracts';
import {
  acceptanceCriteria, agentRuns, clarifications, durableJobs, mergeApprovals, modelProfiles, plans, projects, pullRequests, reviewAcResults, reviewFindings, reviews, storyDependencies, storyEvents, userStories,
  verificationChecks, verificationRuns, type AikDb, type AikTx,
} from '@aik/db';
import type { WorkflowEvent } from '@aik/workflow';
import { and, asc, desc, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ApiHttpError } from '../api/errors.ts';
import { OpenCodeRuntime } from '../agents/runtime.ts';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import type { LocalMerger } from '../git/merger.ts';
import type { GitHubPublishService, PublishResult } from '../github/publish-service.ts';
import type { GitHubPRPoller, PollResult } from '../github/pr-poller.ts';
import type { GitHubSyncService, SyncResult } from '../github/sync-service.ts';
import type { GitHubMergeService } from '../github/merge-service.ts';
import { heavyLane } from '../jobs/lane.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { systemClock, type Clock } from '../time.ts';
import type { PendingRunInterrupt, TransitionOutcome, WorkflowService } from '../workflow/service.ts';
import { getStoryRow, type StoryRow } from '../workflow/snapshot.ts';
import { toStoryDTO } from './dto.ts';

const EDITABLE: readonly StoryStatus[] = ['NEW', 'READY', 'BLOCKED'];
const PRIORITY_ORDER = sql`CASE ${userStories.priority} WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;
const UNAVAILABLE: Record<string, string> = {
  approve_publish: 'GitHub publishing',
  approve_merge: 'the merge pipeline',
  override_remote_review: 'GitHub integration',
};

export function outcomeToError(o: Extract<TransitionOutcome, { ok: false }>): ApiHttpError {
  if (o.code === 'NOT_FOUND') return new ApiHttpError(404, 'NOT_FOUND', 'Story not found');
  if (o.code === 'VERSION_CONFLICT') return new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed; reload and try again', { retryable: true });
  return new ApiHttpError(409, 'GUARD_FAILED', o.failedGuards?.map((g) => g.reason).join('; ') ?? 'Transition not allowed', { failedGuards: o.failedGuards });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class StoryService {
  private readonly db: AikDb;
  private readonly workflow: WorkflowService;
  private readonly bus: EventBus;
  private readonly queue?: JobQueue;
  private readonly merger?: LocalMerger;
  private readonly publishService?: GitHubPublishService;
  private readonly poller?: GitHubPRPoller;
  private readonly syncService?: GitHubSyncService;
  private readonly remoteMerger?: GitHubMergeService;
  private readonly now: Clock;

  constructor(deps: {
    db: AikDb;
    workflow: WorkflowService;
    bus: EventBus;
    queue?: JobQueue;
    merger?: LocalMerger;
    publishService?: GitHubPublishService;
    poller?: GitHubPRPoller;
    syncService?: GitHubSyncService;
    remoteMerger?: GitHubMergeService;
    now?: Clock;
  }) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.queue = deps.queue;
    this.merger = deps.merger;
    this.publishService = deps.publishService;
    this.poller = deps.poller;
    this.syncService = deps.syncService;
    this.remoteMerger = deps.remoteMerger;
    this.now = deps.now ?? systemClock;
  }

  list(projectId: number, query: StoryListQuery): StoryDTO[] {
    const where: SQL[] = [eq(userStories.projectId, projectId)];
    if (query.status) {
      const statuses = query.status.split(',').map((s) => s.trim());
      const bad = statuses.filter((s) => !STORY_STATUS.includes(s as StoryStatus));
      if (bad.length) throw new ApiHttpError(400, 'VALIDATION_FAILED', `Unknown status: ${bad.join(', ')}`);
      where.push(inArray(userStories.status, statuses as StoryStatus[]));
    }
    if (query.label) where.push(sql`EXISTS (SELECT 1 FROM json_each(${userStories.labels}) WHERE json_each.value = ${query.label})`);
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      where.push(sql`(${userStories.title} LIKE ${pattern} ESCAPE '\\' OR ${userStories.description} LIKE ${pattern} ESCAPE '\\')`);
    }
    const order =
      query.sort === 'priority' ? [PRIORITY_ORDER, asc(userStories.rank)]
      : query.sort === 'updated' ? [desc(userStories.updatedAt)]
      : query.sort === 'created' ? [desc(userStories.createdAt)]
      : [asc(userStories.rank)];
    return this.db.select().from(userStories).where(and(...where)).orderBy(...order).all().map((r) => toStoryDTO(this.db, r));
  }

  get(id: number): StoryDTO {
    const row = getStoryRow(this.db, id);
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
    return toStoryDTO(this.db, row);
  }

  create(projectId: number, input: CreateStoryRequest): StoryDTO {
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const project = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ApiHttpError(404, 'NOT_FOUND', `Project ${projectId} not found`);
      if (project.status === 'archived') throw new ApiHttpError(400, 'VALIDATION_FAILED', 'Project is archived');
      const depIds = this.resolveKeys(tx, projectId, input.dependsOn);
      const now = new Date(this.now());
      const key = `${project.key}-${project.nextStoryNumber}`;
      tx.update(projects).set({ nextStoryNumber: project.nextStoryNumber + 1 }).where(eq(projects.id, projectId)).run();
      const maxRank = tx.select({ m: max(userStories.rank) }).from(userStories).where(eq(userStories.projectId, projectId)).get()?.m ?? 0;
      const row = tx
        .insert(userStories)
        .values({ projectId, key, title: input.title, description: input.description, priority: input.priority, labels: input.labels, rank: maxRank + 1024, maxAttempts: project.settings.maxAttempts ?? 3, createdAt: now, updatedAt: now })
        .returning()
        .get();
      this.insertCriteria(tx, row.id, 1, input.acceptanceCriteria, now);
      for (const depId of depIds) tx.insert(storyDependencies).values({ storyId: row.id, dependsOnStoryId: depId }).run();
      tx.insert(storyEvents).values({ storyId: row.id, type: 'created', toStatus: 'NEW', actor: 'human', payload: { key }, createdAt: now }).run();
      if (this.queue) {
        this.queue.enqueue({
          kind: 'plan',
          // The plan runs in the lane of the repository: one job per repository, different
          // repositories in parallel (spec ADV-1).
          slot: heavyLane(project.repoPath),
          storyId: row.id,
          sideEffecting: false,
          idempotencyKey: `plan_${row.id}_${row.revision}`,
        });
      }
      seq = appendOutbox(tx, { topic: 'story.updated', storyId: row.id, provenance: 'system', data: { key, change: 'created' } }, now);
      return toStoryDTO(tx, row);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  patch(id: number, input: PatchStoryRequest): StoryDTO {
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const row = getStoryRow(tx, id);
      if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
      if (row.statusVersion !== input.expectedVersion) {
        throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed; reload and try again', { retryable: true });
      }
      const defChange = input.title !== undefined || input.description !== undefined || input.acceptanceCriteria !== undefined;
      if ((defChange || input.dependsOn !== undefined) && !EDITABLE.includes(row.status)) {
        throw new ApiHttpError(409, 'GUARD_FAILED', `The story definition cannot be edited while it is ${row.status}`, {
          failedGuards: [{ guard: 'editable_state', reason: `Definition edits are allowed in ${EDITABLE.join(', ')} only` }],
        });
      }
      const now = new Date(this.now());
      let current: StoryRow; // assigned by the edit_definition transition below (always true when `current` is read)
      if (defChange) {
        const r = this.workflow.transitionIn(tx, { storyId: id, event: { type: 'edit_definition' }, expectedVersion: row.statusVersion, actor: 'human' });
        if (!r.outcome.ok) throw outcomeToError(r.outcome);
        seq = r.notifySeq;
        current = r.outcome.story;
        if (input.title !== undefined || input.description !== undefined) {
          const defUpdates: Partial<typeof userStories.$inferInsert> = {};
          if (input.title !== undefined) defUpdates.title = input.title;
          if (input.description !== undefined) defUpdates.description = input.description;
          if (Object.keys(defUpdates).length > 0) {
            tx.update(userStories).set(defUpdates).where(eq(userStories.id, id)).run();
          }
        }
        if (input.acceptanceCriteria) {
          tx.update(acceptanceCriteria).set({ supersededAt: now }).where(and(eq(acceptanceCriteria.storyId, id), isNull(acceptanceCriteria.supersededAt))).run();
          this.insertCriteria(tx, id, current.revision, input.acceptanceCriteria, now);
        }
      }
      if (input.dependsOn !== undefined) this.replaceDependencies(tx, row, input.dependsOn);
      const simple: Partial<typeof userStories.$inferInsert> = {};
      if (input.priority !== undefined) simple.priority = input.priority;
      if (input.labels !== undefined) simple.labels = input.labels;
      if (input.rank !== undefined) simple.rank = input.rank;
      const simpleChange = Object.keys(simple).length > 0 || input.dependsOn !== undefined;
      if (simpleChange) {
        tx.update(userStories)
          .set({ ...simple, updatedAt: now, ...(defChange ? {} : { statusVersion: row.statusVersion + 1 }) })
          .where(eq(userStories.id, id))
          .run();
        if (!defChange) {
          tx.insert(storyEvents).values({ storyId: id, type: 'edit', actor: 'human', payload: { fields: Object.keys(input).filter((k) => k !== 'expectedVersion') }, createdAt: now }).run();
          seq = appendOutbox(tx, { topic: 'story.updated', storyId: id, provenance: 'system', data: { key: row.key, change: 'edited' } }, now);
        }
      }
      return toStoryDTO(tx, getStoryRow(tx, id)!);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  transition(id: number, req: TransitionRequest, idempotencyKey?: string): StoryDTO {
    const isAvailable =
      (req.event === 'approve_merge' && (this.merger || this.remoteMerger) && this.queue) ||
      (req.event === 'approve_publish') ||
      (req.event === 'override_remote_review');

    if (req.event in UNAVAILABLE && !isAvailable) {
      throw new ApiHttpError(409, 'GUARD_FAILED', `${req.event} is not available yet`, {
        failedGuards: [{ guard: 'feature_unavailable', reason: `${req.event} is handled by ${UNAVAILABLE[req.event]}, which is not installed in this build` }],
      });
    }

    if (req.event === 'approve_publish') {
      const story = getStoryRow(this.db, id);
      if (!story) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
      const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
      if (!project) throw new ApiHttpError(404, 'NOT_FOUND', `Project for story ${id} not found`);
      if (story.status !== 'AWAITING_MERGE') {
        throw new ApiHttpError(409, 'GUARD_FAILED', `A publish can only be approved while the story is AWAITING_MERGE`, {
          failedGuards: [{ guard: 'state', reason: `approve_publish is not allowed while the story is ${story.status}` }],
        });
      }
      if (story.candidateSha !== req.sha) {
        throw new ApiHttpError(409, 'GUARD_FAILED', 'The approval is not for the current candidate', {
          failedGuards: [{ guard: 'sha', reason: `Candidate ${story.candidateSha ?? 'none'} does not match the approved ${req.sha}` }],
        });
      }
      if (req.expectedVersion !== story.statusVersion) {
        throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed since it was loaded');
      }

      const now = new Date(this.now());
      this.db
        .insert(mergeApprovals)
        .values({
          storyId: id,
          kind: 'publish',
          commitSha: req.sha,
          approver: 'local-user',
          approvedAt: now,
        })
        .onConflictDoNothing()
        .run();

      if (this.publishService) {
        void this.publishService.publishStory(id).then((res) => {
          if (res.ok) this.bus.notify(1);
        });
      }

      return toStoryDTO(this.db, getStoryRow(this.db, id)!);
    }

    if (req.event === 'override_remote_review') {
      const story = getStoryRow(this.db, id);
      if (!story) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
      if (story.status !== 'AWAITING_MERGE') {
        throw new ApiHttpError(409, 'GUARD_FAILED', `Review can only be overridden while AWAITING_MERGE`, {
          failedGuards: [{ guard: 'state', reason: `override_remote_review is not allowed while the story is ${story.status}` }],
        });
      }
      if (story.candidateSha !== req.sha) {
        throw new ApiHttpError(409, 'GUARD_FAILED', 'The override is not for the current candidate', {
          failedGuards: [{ guard: 'sha', reason: `Candidate ${story.candidateSha ?? 'none'} does not match the approved ${req.sha}` }],
        });
      }
      if (req.expectedVersion !== story.statusVersion) {
        throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed since it was loaded');
      }

      const now = new Date(this.now());
      this.db
        .insert(mergeApprovals)
        .values({
          storyId: id,
          kind: 'override_remote_review',
          commitSha: req.sha,
          approver: 'local-user',
          note: req.note,
          approvedAt: now,
        })
        .onConflictDoNothing()
        .run();

      this.bus.notify(1);
      return toStoryDTO(this.db, getStoryRow(this.db, id)!);
    }

    if (req.event === 'approve_merge' && (this.merger || this.remoteMerger) && this.queue) {
      const queue = this.queue;
      const story = getStoryRow(this.db, id);
      if (!story) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
      const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
      if (!project) throw new ApiHttpError(404, 'NOT_FOUND', `Project for story ${id} not found`);
      if (story.status !== 'AWAITING_MERGE') {
        throw new ApiHttpError(409, 'GUARD_FAILED', `A merge can only be approved while the story is AWAITING_MERGE`, {
          failedGuards: [{ guard: 'state', reason: `approve_merge is not allowed while the story is ${story.status}` }],
        });
      }
      if (story.candidateSha !== req.sha) {
        throw new ApiHttpError(409, 'GUARD_FAILED', 'The approval is not for the current candidate', {
          failedGuards: [{ guard: 'sha', reason: `Candidate ${story.candidateSha ?? 'none'} does not match the approved ${req.sha}` }],
        });
      }
      if (req.expectedVersion !== story.statusVersion) {
        throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed since it was loaded');
      }

      const now = new Date(this.now());
      const inserted = this.db
        .insert(mergeApprovals)
        .values({
          storyId: id,
          kind: 'merge',
          commitSha: req.sha,
          approver: 'local-user',
          approvedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: mergeApprovals.id })
        .get();
      // A repeated approval of the same candidate conflicts away on (storyId, kind, commitSha); the
      // job must still reference the one approval row that exists, so re-read it.
      const approval =
        inserted ??
        this.db
          .select({ id: mergeApprovals.id })
          .from(mergeApprovals)
          .where(and(eq(mergeApprovals.storyId, id), eq(mergeApprovals.kind, 'merge'), eq(mergeApprovals.commitSha, req.sha)))
          .get()!;

      // At most one live merge job per story: a queued job, or a leased job whose lease has not
      // expired, is already carrying this candidate to the merger. A leased job with a dead lease
      // is not live (the runner lost it), so a re-approval must still be able to enqueue a retry.
      const nowMs = this.now();
      const liveJobs = this.db
        .select({ id: durableJobs.id, status: durableJobs.status, leaseExpiresAt: durableJobs.leaseExpiresAt })
        .from(durableJobs)
        .where(and(eq(durableJobs.storyId, id), eq(durableJobs.kind, 'merge'), inArray(durableJobs.status, ['queued', 'leased'])))
        .all();
      const live = liveJobs.some((j) => j.status === 'queued' || (j.leaseExpiresAt !== null && j.leaseExpiresAt.getTime() > nowMs));
      if (!live) {
        queue.enqueue({
          kind: 'merge',
          // The merge runs in the lane of the repository: one merge at a time per repository,
          // while other repositories keep working in parallel (spec ADV-1).
          slot: heavyLane(project.repoPath),
          storyId: id,
          sideEffecting: true,
          payload: { sha: req.sha, approvalId: approval.id },
          // A failed merge must be retryable: bind the job to the approval request rather than only
          // to the candidate SHA, otherwise every re-approval collapses onto the failed job.
          idempotencyKey: `merge_${id}_${req.sha}_${idempotencyKey ?? crypto.randomUUID()}`,
        });
      }
      this.bus.notify(1);
      return toStoryDTO(this.db, getStoryRow(this.db, id)!);
    }
    let seq: number | null = null;
    let interrupts: PendingRunInterrupt[] = [];
    const dto = this.db.transaction((tx) => {
      const event = this.toWorkflowEvent(req);
      // BA condition C3: the machine only sees counts — the service validates the exact ordinal
      // set against the current proposed plan so violations can name the offending ordinals.
      // QA D1: skip validation when this idempotency key already produced a transition (crash-
      // window replay) — transitionIn must return the duplicate outcome, not a fresh guard error.
      const replayed = idempotencyKey
        ? !!tx.select({ id: storyEvents.id }).from(storyEvents).where(eq(storyEvents.idempotencyKey, idempotencyKey)).get()
        : false;
      if (req.event === 'answer_clarifications' && !replayed) this.validateClarificationAnswers(tx, id, req);
      const r = this.workflow.transitionIn(tx, { storyId: id, event, expectedVersion: req.expectedVersion, actor: 'human', idempotencyKey });
      if (!r.outcome.ok) throw outcomeToError(r.outcome);
      seq = r.notifySeq;
      interrupts = r.interrupts;
      if (req.event === 'request_changes' && !r.outcome.duplicate) this.recordHumanReview(tx, id, req);
      return toStoryDTO(tx, r.outcome.story);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    // BA condition C1: this human path commits through transitionIn (it never calls
    // workflow.transition), so the interrupt side effect must be fired here too — after
    // commit, best-effort, identically to WorkflowService.transition().
    this.workflow.emitInterrupts(interrupts);
    return dto;
  }

  async revertMerge(id: number, expectedVersion: number): Promise<{ ok: boolean; revertSha: string; story: StoryDTO }> {
    if (!this.merger) {
      throw new ApiHttpError(409, 'GUARD_FAILED', 'Merge pipeline is not installed in this build');
    }
    const story = getStoryRow(this.db, id);
    if (!story) throw new ApiHttpError(404, 'NOT_FOUND', `Story ${id} not found`);
    if (story.status !== 'BLOCKED' || story.blockedReason !== 'post_merge_failed') {
      throw new ApiHttpError(
        409,
        'GUARD_FAILED',
        `Reverting a merge is only allowed when post-merge verification failed (current: ${story.status}${story.blockedReason ? `/${story.blockedReason}` : ''})`,
      );
    }
    if (expectedVersion !== story.statusVersion) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'The story changed since it was loaded');
    }

    const result = await this.merger.revertFailedMerge({ storyId: id });
    if (!result.ok || !result.revertSha) {
      throw new ApiHttpError(409, 'GUARD_FAILED', result.error ?? 'Failed to revert merge');
    }

    const updated = getStoryRow(this.db, id)!;
    return {
      ok: true,
      revertSha: result.revertSha,
      story: toStoryDTO(this.db, updated),
    };
  }

  private toWorkflowEvent(req: TransitionRequest): WorkflowEvent {
    switch (req.event) {
      case 'approve_plan':
        return { type: 'approve_plan', planVersion: req.planVersion };
      case 'reject_plan':
        return { type: 'reject_plan', planVersion: req.planVersion, feedback: req.feedback };
      case 'answer_clarifications':
        return { type: 'answer_clarifications', planVersion: req.planVersion, answers: req.answers };
      case 'request_changes':
        return { type: 'request_changes', sha: req.sha };
      case 'recover':
        // Phase 1 has no component that can still be failing; Phase 2 replaces `true` with real cause checks.
        return { type: 'recover', target: req.target, extraAttempts: req.extraAttempts ?? 0, causeResolved: true };
      case 'cancel':
        return { type: 'cancel' };
      case 'hold':
        return { type: 'hold' };
      case 'unhold':
        return { type: 'unhold' };
      case 'stop_run':
        return { type: 'stop_run' };
      default:
        throw new ApiHttpError(409, 'GUARD_FAILED', `${req.event} is not available yet`);
    }
  }

  /**
   * BA condition C3: the machine's `answer_clarifications` guard only compares counts
   * (`answers.length === openClarifications`); this pre-validation checks the exact ordinal set
   * against the current proposed plan so a violation names the offending ordinals/answers. A
   * missing plan, a version mismatch or a non-proposed plan is deliberately left to the
   * machine's plan guard — this only runs when the request targets the current proposed plan.
   */
  private validateClarificationAnswers(tx: AikTx, storyId: number, req: Extract<TransitionRequest, { event: 'answer_clarifications' }>): void {
    // QA D2: any state other than needs_clarification is the machine's to explain (its
    // planning_status guard names the actual status) — only ordinal hygiene is checked here.
    const story = getStoryRow(tx, storyId);
    if (!story || story.planningStatus !== 'needs_clarification') return;
    // Same lookup the machine's evidence uses (snapshot.ts): the story's latest plan row.
    const plan = tx.select().from(plans).where(eq(plans.storyId, storyId)).orderBy(desc(plans.version)).limit(1).get();
    if (!plan || plan.version !== req.planVersion || plan.status !== 'proposed') return;
    const openOrdinals = new Set(
      tx
        .select({ ordinal: clarifications.ordinal })
        .from(clarifications)
        .where(and(eq(clarifications.planId, plan.id), isNull(clarifications.answer)))
        .all()
        .map((r) => r.ordinal),
    );
    const answered = new Set<number>();
    const duplicates: number[] = [];
    const unknown: number[] = [];
    const empty: number[] = [];
    for (const a of req.answers) {
      if (answered.has(a.ordinal)) duplicates.push(a.ordinal);
      if (!openOrdinals.has(a.ordinal)) unknown.push(a.ordinal);
      else answered.add(a.ordinal);
      if (a.answer.trim().length === 0) empty.push(a.ordinal);
    }
    const missing = [...openOrdinals].filter((o) => !answered.has(o));
    if (missing.length === 0 && unknown.length === 0 && duplicates.length === 0 && empty.length === 0) return;
    const list = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b).join(', ');
    const problems = [
      missing.length ? `missing ordinals ${list(missing)}` : '',
      unknown.length ? `unknown ordinals ${list(unknown)}` : '',
      duplicates.length ? `duplicate ordinals ${list(duplicates)}` : '',
      empty.length ? `empty answers for ordinals ${list(empty)}` : '',
    ].filter((p) => p.length > 0);
    throw new ApiHttpError(409, 'GUARD_FAILED', 'The clarification answers do not match the open clarification questions', {
      failedGuards: [{ guard: 'clarifications', reason: `Every open clarification needs exactly one non-empty answer; found ${problems.join('; ')}` }],
    });
  }

  private recordHumanReview(tx: AikTx, storyId: number, req: Extract<TransitionRequest, { event: 'request_changes' }>): void {
    const now = new Date(this.now());
    const findings = req.findings.map((f, i) => ({
      id: `H-${i + 1}`, severity: 'high' as const, category: 'other' as const, file: f.file, evidence: f.text,
      explanation: f.text, recommendation: f.text, blocking: true,
    }));
    const review = tx
      .insert(reviews)
      .values({
        storyId, commitSha: req.sha, actor: 'human', agentRunId: null, rawVerdict: 'CHANGES_REQUESTED', verdict: 'CHANGES_REQUESTED',
        summary: 'Changes requested by a human at merge review',
        raw: { schemaVersion: 1, verdict: 'CHANGES_REQUESTED', summary: 'Changes requested by a human', acChecklist: [], findings, priorFindings: [] },
        createdAt: now,
      })
      .returning({ id: reviews.id })
      .get();
    for (const f of findings) {
      tx.insert(reviewFindings).values({
        reviewId: review.id, findingKey: f.id, severity: f.severity, category: f.category, filePath: f.file ?? null,
        evidence: f.evidence, explanation: f.explanation, recommendation: f.recommendation, blocking: true,
      }).run();
    }
  }

  private insertCriteria(tx: AikTx, storyId: number, revision: number, texts: string[], now: Date): void {
    texts.forEach((text, i) =>
      tx.insert(acceptanceCriteria).values({ storyId, storyRevision: revision, ordinal: i + 1, text, source: 'human', createdAt: now }).run(),
    );
  }

  private resolveKeys(tx: AikTx, projectId: number, keys: string[]): number[] {
    if (keys.length === 0) return [];
    const rows = tx.select({ id: userStories.id, key: userStories.key }).from(userStories)
      .where(and(eq(userStories.projectId, projectId), inArray(userStories.key, keys))).all();
    const missing = keys.filter((k) => !rows.some((r) => r.key === k));
    if (missing.length) throw new ApiHttpError(400, 'VALIDATION_FAILED', `Unknown dependency: ${missing.join(', ')}`);
    return rows.map((r) => r.id);
  }

  private replaceDependencies(tx: AikTx, story: StoryRow, keys: string[]): void {
    const depIds = this.resolveKeys(tx, story.projectId, keys);
    if (depIds.includes(story.id)) throw new ApiHttpError(400, 'VALIDATION_FAILED', 'A story cannot depend on itself');
    const all = tx
      .select({ from: storyDependencies.storyId, to: storyDependencies.dependsOnStoryId })
      .from(storyDependencies)
      .innerJoin(userStories, eq(userStories.id, storyDependencies.storyId))
      .where(eq(userStories.projectId, story.projectId))
      .all()
      .filter((e) => e.from !== story.id);
    const edges = new Map<number, number[]>();
    for (const e of [...all, ...depIds.map((to) => ({ from: story.id, to }))]) edges.set(e.from, [...(edges.get(e.from) ?? []), e.to]);
    const path = findPath(edges, story.id, story.id);
    if (path) {
      const keyOf = new Map(tx.select({ id: userStories.id, key: userStories.key }).from(userStories).where(eq(userStories.projectId, story.projectId)).all().map((r) => [r.id, r.key]));
      throw new ApiHttpError(400, 'VALIDATION_FAILED', `Dependency cycle: ${path.map((n) => keyOf.get(n)).join(' → ')}`);
    }
    tx.delete(storyDependencies).where(eq(storyDependencies.storyId, story.id)).run();
    for (const depId of depIds) tx.insert(storyDependencies).values({ storyId: story.id, dependsOnStoryId: depId }).run();
  }

  async getAgentRun(storyId: number): Promise<{
    run: {
      id: number;
      role: string;
      status: string;
      model: string;
      opencodeSessionId: string | null;
      startedAt: number;
      endedAt: number | null;
      exitReason: string | null;
    } | null;
    messages: unknown[];
  }> {
    const story = getStoryRow(this.db, storyId);
    if (!story) throw new ApiHttpError(404, 'NOT_FOUND', 'Story not found');
    const run = story.activeRunId
      ? this.db
          .select({
            id: agentRuns.id,
            role: agentRuns.role,
            status: agentRuns.status,
            exitReason: agentRuns.exitReason,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
            opencodeSessionId: agentRuns.opencodeSessionId,
            model: modelProfiles.modelId,
          })
          .from(agentRuns)
          .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.modelProfileId))
          .where(eq(agentRuns.id, story.activeRunId))
          .get()
      : this.db
          .select({
            id: agentRuns.id,
            role: agentRuns.role,
            status: agentRuns.status,
            exitReason: agentRuns.exitReason,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
            opencodeSessionId: agentRuns.opencodeSessionId,
            model: modelProfiles.modelId,
          })
          .from(agentRuns)
          .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.modelProfileId))
          .where(eq(agentRuns.storyId, storyId))
          .orderBy(desc(agentRuns.id))
          .limit(1)
          .get();

    if (!run) return { run: null, messages: [] };

    let messages: unknown[] = [];
    if (run.opencodeSessionId) {
      try {
        const runtime = new OpenCodeRuntime();
        const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();
        const res = await runtime.getSessionMessages(run.opencodeSessionId, project?.repoPath);
        if (res.ok) {
          messages = res.messages;
        }
      } catch {
        // ignore message fetch errors
      }
    }

    return {
      run: {
        id: run.id,
        role: run.role,
        status: run.status,
        model: run.model || 'OpenCode',
        opencodeSessionId: run.opencodeSessionId ?? null,
        startedAt: run.startedAt?.getTime() ?? 0,
        endedAt: run.endedAt?.getTime() ?? null,
        exitReason: run.exitReason ?? null,
      },
      messages,
    };
  }

  getDetails(storyId: number): {
    plan: PlanV1 | null;
    verification: {
      status: string;
      commitSha: string;
      checks: { key: string; mandatory: boolean; command: string; status: string; exitCode: number | null; outputTail: string | null }[];
    } | null;
    review: {
      verdict: string;
      rawVerdict: string;
      summary: string;
      normalizationNote: string | null;
      findings: { id: string; severity: string; category: string; file: string | null; explanation: string; recommendation: string; blocking: boolean; unverifiedLocation: boolean }[];
      acResults: { criterionId: number; text: string; status: string; evidence: string }[];
    } | null;
    diff: string | null;
  } {
    const story = getStoryRow(this.db, storyId);
    if (!story) throw new ApiHttpError(404, 'NOT_FOUND', 'Story not found');
    const project = this.db.select().from(projects).where(eq(projects.id, story.projectId)).get();

    // 1. Plan
    const planRow = story.activePlanId
      ? this.db.select().from(plans).where(eq(plans.id, story.activePlanId)).get()
      : this.db.select().from(plans).where(eq(plans.storyId, storyId)).orderBy(desc(plans.version)).limit(1).get();

    // 2. Verification
    let verification: {
      status: string;
      commitSha: string;
      checks: { key: string; mandatory: boolean; command: string; status: string; exitCode: number | null; outputTail: string | null }[];
    } | null = null;
    if (story.candidateSha) {
      const vRun = this.db
        .select()
        .from(verificationRuns)
        .where(and(eq(verificationRuns.storyId, storyId), eq(verificationRuns.commitSha, story.candidateSha)))
        .orderBy(desc(verificationRuns.id))
        .limit(1)
        .get();

      if (vRun) {
        const checks = this.db
          .select({
            key: verificationChecks.checkKey,
            mandatory: verificationChecks.mandatory,
            command: verificationChecks.command,
            status: verificationChecks.status,
            exitCode: verificationChecks.exitCode,
            outputTail: verificationChecks.outputTail,
          })
          .from(verificationChecks)
          .where(eq(verificationChecks.verificationRunId, vRun.id))
          .all();

        verification = {
          status: vRun.status,
          commitSha: vRun.commitSha,
          checks,
        };
      }
    }

    // 3. Review
    let review: {
      verdict: string;
      rawVerdict: string;
      summary: string;
      normalizationNote: string | null;
      findings: { id: string; severity: string; category: string; file: string | null; explanation: string; recommendation: string; blocking: boolean; unverifiedLocation: boolean }[];
      acResults: { criterionId: number; text: string; status: string; evidence: string }[];
    } | null = null;
    if (story.candidateSha) {
      const rev = this.db
        .select()
        .from(reviews)
        .where(and(eq(reviews.storyId, storyId), eq(reviews.commitSha, story.candidateSha)))
        .orderBy(desc(reviews.id))
        .limit(1)
        .get();

      if (rev) {
        const findingRows = this.db
          .select({
            id: reviewFindings.findingKey,
            severity: reviewFindings.severity,
            category: reviewFindings.category,
            file: reviewFindings.filePath,
            explanation: reviewFindings.explanation,
            recommendation: reviewFindings.recommendation,
            blocking: reviewFindings.blocking,
            locationVerified: reviewFindings.locationVerified,
          })
          .from(reviewFindings)
          .where(eq(reviewFindings.reviewId, rev.id))
          .all();

        const acResults = this.db
          .select({
            criterionId: reviewAcResults.acceptanceCriterionId,
            text: acceptanceCriteria.text,
            status: reviewAcResults.status,
            evidence: reviewAcResults.evidence,
          })
          .from(reviewAcResults)
          .innerJoin(acceptanceCriteria, eq(acceptanceCriteria.id, reviewAcResults.acceptanceCriterionId))
          .where(eq(reviewAcResults.reviewId, rev.id))
          .all();

        review = {
          verdict: rev.verdict,
          rawVerdict: rev.rawVerdict,
          summary: rev.summary,
          normalizationNote: rev.normalizationNote,
          findings: findingRows.map(({ locationVerified, ...finding }) => ({ ...finding, unverifiedLocation: !locationVerified })),
          acResults,
        };
      }
    }

    // 4. Git diff
    let diff: string | null = null;
    if (project && story.candidateSha) {
      try {
        diff = execFileSync('git', ['diff', `${project.baseBranch}..${story.candidateSha}`], {
          cwd: project.repoPath,
          encoding: 'utf8',
        });
      } catch {
        diff = null;
      }
    }

    return {
      plan: planRow?.content ?? null,
      verification,
      review,
      diff,
    };
  }

  getPullRequest(storyId: number): PullRequestDTO | null {
    const row = this.db.select().from(pullRequests).where(eq(pullRequests.storyId, storyId)).orderBy(desc(pullRequests.id)).limit(1).get();
    if (!row) return null;
    return {
      id: row.id,
      storyId: row.storyId,
      repositoryConnectionId: row.repositoryConnectionId,
      number: row.number,
      url: row.url,
      headBranch: row.headBranch,
      headSha: row.headSha,
      baseBranch: row.baseBranch,
      state: row.state as 'open' | 'closed' | 'merged',
      mergeable: row.mergeable,
      checksSummary: row.checksSummary
        ? {
            total: row.checksSummary.total,
            passed: row.checksSummary.passed,
            failed: row.checksSummary.failed,
            pending: row.checksSummary.pending,
            conclusion: row.checksSummary.conclusion,
            checks: row.checksSummary.checks ?? [],
          }
        : null,
      reviewsSummary: row.reviewsSummary
        ? {
            approved: row.reviewsSummary.approved,
            changesRequested: row.reviewsSummary.changesRequested,
            commented: row.reviewsSummary.commented,
            state: row.reviewsSummary.state ?? 'NONE',
            reviews: row.reviewsSummary.reviews ?? [],
          }
        : null,
      mergeCommitSha: row.mergeCommitSha,
      lastPolledAt: row.lastPolledAt?.getTime() ?? null,
    };
  }

  async publish(storyId: number): Promise<PublishResult> {
    if (!this.publishService) {
      throw new ApiHttpError(409, 'GUARD_FAILED', 'GitHub publishing is not available in this build');
    }
    return this.publishService.publishStory(storyId);
  }

  async syncBase(storyId: number): Promise<SyncResult> {
    if (!this.syncService) {
      throw new ApiHttpError(409, 'GUARD_FAILED', 'GitHub base sync is not available in this build');
    }
    return this.syncService.syncStoryWithBase(storyId);
  }

  async pollPullRequest(storyId: number): Promise<PollResult> {
    if (!this.poller) {
      throw new ApiHttpError(409, 'GUARD_FAILED', 'GitHub PR polling is not available in this build');
    }
    const pr = this.db.select().from(pullRequests).where(eq(pullRequests.storyId, storyId)).orderBy(desc(pullRequests.id)).limit(1).get();
    if (!pr) {
      throw new ApiHttpError(404, 'NOT_FOUND', `No pull request found for story ${storyId}`);
    }
    return this.poller.pollPullRequest(pr.id);
  }
}

/** Depth-first search for a path start → … → target (length ≥ 1). */
function findPath(edges: Map<number, number[]>, start: number, target: number): number[] | null {
  const stack: { node: number; path: number[] }[] = [{ node: start, path: [start] }];
  const seen = new Set<number>();
  while (stack.length) {
    const { node, path } = stack.pop()!;
    for (const next of edges.get(node) ?? []) {
      if (next === target) return [...path, next];
      if (!seen.has(next)) {
        seen.add(next);
        stack.push({ node: next, path: [...path, next] });
      }
    }
  }
  return null;
}
