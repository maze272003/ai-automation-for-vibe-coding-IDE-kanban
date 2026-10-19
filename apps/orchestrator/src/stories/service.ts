// apps/orchestrator/src/stories/service.ts
import {
  STORY_STATUS, type CreateStoryRequest, type PatchStoryRequest, type StoryDTO, type StoryListQuery, type StoryStatus, type TransitionRequest,
} from '@aik/contracts';
import {
  acceptanceCriteria, agentRuns, modelProfiles, projects, reviewFindings, reviews, storyDependencies, storyEvents, userStories, type AikDb, type AikTx,
} from '@aik/db';
import type { WorkflowEvent } from '@aik/workflow';
import { and, asc, desc, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { ApiHttpError } from '../api/errors.ts';
import { OpenCodeRuntime } from '../agents/runtime.ts';
import type { EventBus } from '../events/bus.ts';
import { appendOutbox } from '../events/outbox.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { systemClock, type Clock } from '../time.ts';
import type { TransitionOutcome, WorkflowService } from '../workflow/service.ts';
import { getStoryRow, type StoryRow } from '../workflow/snapshot.ts';
import { toStoryDTO } from './dto.ts';

const EDITABLE: readonly StoryStatus[] = ['NEW', 'READY', 'BLOCKED'];
const PRIORITY_ORDER = sql`CASE ${userStories.priority} WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;
const UNAVAILABLE: Record<string, string> = {
  reject_plan: 'the planner', answer_clarifications: 'the planner', approve_publish: 'GitHub publishing',
  approve_merge: 'the merge pipeline', override_remote_review: 'GitHub integration',
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
  private readonly now: Clock;

  constructor(deps: { db: AikDb; workflow: WorkflowService; bus: EventBus; queue?: JobQueue; now?: Clock }) {
    this.db = deps.db;
    this.workflow = deps.workflow;
    this.bus = deps.bus;
    this.queue = deps.queue;
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
          slot: 'heavy',
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
    if (req.event in UNAVAILABLE) {
      throw new ApiHttpError(409, 'GUARD_FAILED', `${req.event} is not available yet`, {
        failedGuards: [{ guard: 'feature_unavailable', reason: `${req.event} is handled by ${UNAVAILABLE[req.event]}, which is not installed in this build` }],
      });
    }
    let seq: number | null = null;
    const dto = this.db.transaction((tx) => {
      const event = this.toWorkflowEvent(req);
      const r = this.workflow.transitionIn(tx, { storyId: id, event, expectedVersion: req.expectedVersion, actor: 'human', idempotencyKey });
      if (!r.outcome.ok) throw outcomeToError(r.outcome);
      seq = r.notifySeq;
      if (req.event === 'request_changes' && !r.outcome.duplicate) this.recordHumanReview(tx, id, req);
      return toStoryDTO(tx, r.outcome.story);
    }, { behavior: 'immediate' });
    if (seq !== null) this.bus.notify(seq);
    return dto;
  }

  private toWorkflowEvent(req: TransitionRequest): WorkflowEvent {
    switch (req.event) {
      case 'approve_plan':
        return { type: 'approve_plan', planVersion: req.planVersion };
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
