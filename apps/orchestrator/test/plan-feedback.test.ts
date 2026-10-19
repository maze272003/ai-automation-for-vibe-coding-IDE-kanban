// apps/orchestrator/test/plan-feedback.test.ts
// Cross-cutting integration coverage for the plan-feedback loop plan (EXE-7 AC 2/AC 4):
// planner questions → needs_clarification with persisted clarification rows and no auto-accept;
// answer_clarifications → answers persisted, back to planning, runner re-plans with the Q&A in
// the prompt; reject_plan → rejected plan + feedback persisted, re-plan prompt carries the
// feedback (twice in a row — the versioned discovery key must not collide); T1 approve still
// works on the new proposal and the earlier plan rows stay untouched (immutable history).
// Service layer end-to-end: real temp SQLite, real PlannerAgent/StoryService/AgentRunner, fake
// OpenCode runtime scripted per planner run.
import type { PlanV1 } from '@aik/contracts';
import { clarifications, durableJobs, plans, storyEvents } from '@aik/db';
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ImplementerAgent } from '../src/agents/implementer.ts';
import { PlannerAgent } from '../src/agents/planner.ts';
import type { ReviewerAgent } from '../src/agents/reviewer.ts';
import { AgentRunner } from '../src/agents/runner.ts';
import type { OpenCodeRuntime, RunOneShotInput, RunOneShotOutput } from '../src/agents/runtime.ts';
import { ApiHttpError } from '../src/api/errors.ts';
import { EventBus } from '../src/events/bus.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { StoryService } from '../src/stories/service.ts';
import { getStoryRow } from '../src/workflow/snapshot.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import type { VerificationRunner } from '../src/verify/runner.ts';
import { createTestDb, seedAcceptanceCriterion, seedProject, seedStory } from './helpers/db.ts';

const Q1 = 'Which export formats must be supported?';
const A1 = 'CSV and JSON only';
const Q2 = 'Must the export respect the active board filter?';
const A2 = 'Yes, export only the filtered rows';
const FEEDBACK = 'Stream large exports instead of buffering the whole file in memory';
const FEEDBACK_2 = 'Also add a progress indicator for large exports';

const planWithQuestions: PlanV1 = {
  schemaVersion: 1,
  summary: 'Buffered export endpoint',
  assumptions: ['The export runs server-side'],
  clarificationQuestions: [Q1, Q2],
  acceptanceCriteria: [{ ref: 'AC-1', text: 'The export produces a file in the requested format', testable: true, verification: 'Unit test' }],
  subtasks: [{ id: '1', description: 'Add the export endpoint', files: ['src/export.ts'] }],
  affectedFiles: ['src/export.ts'],
  requiredTests: ['test/export.test.ts'],
  migrations: { required: false, notes: '' },
  securitySensitive: [],
  dependencyChanges: [],
  conflictsWith: [],
  complexity: 'S',
  risks: [],
};

const planWithoutQuestions = (summary: string): PlanV1 => ({ ...planWithQuestions, summary, clarificationQuestions: [] });

/** Fake runtime returning one scripted PlanV1 per planner run (last script repeats) and capturing every prompt. */
const scriptedPlannerRuntime = (scripts: PlanV1[]): { runtime: OpenCodeRuntime; prompts: string[] } => {
  const prompts: string[] = [];
  let call = 0;
  const runtime = {
    runOneShot: async (input: RunOneShotInput): Promise<RunOneShotOutput> => {
      call += 1;
      prompts.push(input.prompt);
      await input.onSessionCreated?.(`ses_plan_feedback_${call}`, undefined);
      const script = scripts[Math.min(call - 1, scripts.length - 1)]!;
      return { ok: true, text: '```json\n' + JSON.stringify(script) + '\n```' };
    },
    interrupt: async () => true,
  } as unknown as OpenCodeRuntime;
  return { runtime, prompts };
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Runs `fn`, returning the thrown error (null when nothing threw) so expect()s can label each case. */
const capture = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

describe('plan feedback loop (EXE-7 AC2/AC4) — cross-cutting, service layer', () => {
  let t: ReturnType<typeof createTestDb>;
  let bus: EventBus;
  let workflow: WorkflowService;
  let stories: StoryService;
  let queue: JobQueue;

  beforeEach(() => {
    t = createTestDb();
    bus = new EventBus();
    workflow = new WorkflowService({ db: t.db, bus });
    stories = new StoryService({ db: t.db, workflow, bus });
    queue = new JobQueue(t.db);
    return () => t.close();
  });

  const storyRow = (id: number) => getStoryRow(t.db, id)!;
  const planRows = (storyId: number) => t.db.select().from(plans).where(eq(plans.storyId, storyId)).orderBy(asc(plans.version)).all();
  const clarificationRows = (planId: number) =>
    t.db.select().from(clarifications).where(eq(clarifications.planId, planId)).orderBy(asc(clarifications.ordinal)).all();
  const transitionEvents = (storyId: number) =>
    t.db.select().from(storyEvents).where(and(eq(storyEvents.storyId, storyId), eq(storyEvents.type, 'transition'))).all();
  const planJobs = (storyId: number) =>
    t.db.select().from(durableJobs).where(and(eq(durableJobs.storyId, storyId), eq(durableJobs.kind, 'plan'))).all();

  const setup = (scripts: PlanV1[]) => {
    const { runtime, prompts } = scriptedPlannerRuntime(scripts);
    const planner = new PlannerAgent({ db: t.db, workflow, bus, runtime });
    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, {
      key: 'PF-1',
      title: 'Export the board to a file',
      description: 'Users need to export the current board contents to a downloadable file.',
    });
    seedAcceptanceCriterion(t.db, story.id, 'The export produces a downloadable file');
    const implementStory = vi.fn();
    const runner = new AgentRunner({
      db: t.db,
      queue,
      workflow,
      bus,
      planner,
      implementer: { implementStory } as unknown as ImplementerAgent,
      verification: { verifyStory: vi.fn() } as unknown as VerificationRunner,
      reviewer: { reviewStory: vi.fn() } as unknown as ReviewerAgent,
    });
    return { project, story, planner, runner, prompts, implementStory };
  };

  test('AC1 — a plan with clarification questions keeps the story NEW in needs_clarification, persists the questions, and never auto-accepts', async () => {
    const { story, planner } = setup([planWithQuestions]);

    // autoAccept is on: with open questions it must be suppressed, not fired.
    const result = await planner.planStory({ storyId: story.id, autoAccept: true });

    expect(result.ok).toBe(true);
    expect(result.planId).toBeTypeOf('number');

    // Story stays NEW, parked in needs_clarification, with no run attached and no transition fired.
    expect(storyRow(story.id)).toMatchObject({ status: 'NEW', planningStatus: 'needs_clarification', activeRunId: null, statusVersion: 0 });
    expect(transitionEvents(story.id)).toHaveLength(0);

    // The plan row stays a plain proposal — never approved — and keeps the questions in its content.
    const rows = planRows(story.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.planId, version: 1, status: 'proposed', approvedBy: null, approvedAt: null, rejectionFeedback: null });
    expect(rows[0]!.content.clarificationQuestions).toEqual([Q1, Q2]);

    // One clarification row per question: ordinal + question persisted, answer open.
    expect(clarificationRows(result.planId!)).toEqual([
      expect.objectContaining({ planId: result.planId, ordinal: 1, question: Q1, answer: null, answeredAt: null }),
      expect.objectContaining({ planId: result.planId, ordinal: 2, question: Q2, answer: null, answeredAt: null }),
    ]);
  });

  test('AC2 — answering every open clarification persists the answers, returns to planning, and the re-plan prompt carries the Q&A', async () => {
    const { story, planner, runner, prompts, implementStory } = setup([planWithQuestions, planWithoutQuestions('Streaming export endpoint')]);
    const r1 = await planner.planStory({ storyId: story.id, autoAccept: true });
    expect(r1.ok).toBe(true);
    const planIdV1 = r1.planId!;

    // While clarifications are open, T1 stays blocked on the clarifications guard (AC4's denied arm).
    const before = storyRow(story.id);
    const openApprove = capture(() => stories.transition(story.id, { event: 'approve_plan', planVersion: 1, expectedVersion: before.statusVersion }));
    expect(openApprove).toBeInstanceOf(ApiHttpError);
    expect((openApprove as ApiHttpError).statusCode).toBe(409);
    expect((openApprove as ApiHttpError).failedGuards?.map((g) => g.guard)).toContain('clarifications');

    const dto = stories.transition(story.id, {
      event: 'answer_clarifications',
      planVersion: 1,
      answers: [
        { ordinal: 1, answer: A1 },
        { ordinal: 2, answer: A2 },
      ],
      expectedVersion: before.statusVersion,
    });

    expect(dto).toMatchObject({ status: 'NEW', planningStatus: 'planning' });
    expect(dto.statusVersion).toBe(before.statusVersion + 1);

    // Answers persisted on the plan's clarification rows with a timestamp.
    const answered = clarificationRows(planIdV1);
    expect(answered.map((c) => [c.ordinal, c.question, c.answer])).toEqual([[1, Q1, A1], [2, Q2, A2]]);
    expect(answered.every((c) => c.answeredAt instanceof Date)).toBe(true);

    // One tick: discovery enqueues the re-plan job and the handler runs the planner a second time.
    await sleep(5); // planner run ids derive from Date.now(); keep the two runs in distinct milliseconds
    await runner.tick();

    const jobs = planJobs(story.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'plan', status: 'succeeded' });
    // Frozen assumption: the re-plan key carries the next plan version, so re-plans never collide.
    expect(jobs[0]!.idempotencyKey).toBe(`auto_plan_${story.id}_${story.revision}_v2`);

    // The re-plan prompt contains the full Q&A; the first prompt could not have known the answers.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain(A1);
    expect(prompts[1]).toContain(Q1);
    expect(prompts[1]).toContain(A1);
    expect(prompts[1]).toContain(Q2);
    expect(prompts[1]).toContain(A2);

    // Plan v2 proposed with zero questions; v1 untouched apart from the answers now on its rows.
    const rows = planRows(story.id);
    expect(rows.map((p) => [p.version, p.status])).toEqual([[1, 'proposed'], [2, 'proposed']]);
    expect(rows[1]!.content.clarificationQuestions).toEqual([]);
    expect(storyRow(story.id)).toMatchObject({ status: 'NEW', planningStatus: 'plan_proposed', activePlanId: rows[1]!.id, activeRunId: null });
    expect(stories.get(story.id)).toMatchObject({ activePlanVersion: 2 });
    expect(implementStory).not.toHaveBeenCalled();
  });

  test('AC2 — missing/unknown/duplicate ordinals and blank answers are GUARD_FAILED naming the ordinals, and nothing is persisted', async () => {
    const { story, planner } = setup([planWithQuestions]);
    const r1 = await planner.planStory({ storyId: story.id, autoAccept: true });
    expect(r1.ok).toBe(true);
    expect(storyRow(story.id).planningStatus).toBe('needs_clarification');
    const version = storyRow(story.id).statusVersion;

    const violations: [string, { ordinal: number; answer: string }[], RegExp][] = [
      ['missing ordinal', [{ ordinal: 1, answer: A1 }], /\b2\b/],
      ['unknown ordinal', [{ ordinal: 1, answer: A1 }, { ordinal: 2, answer: A2 }, { ordinal: 3, answer: 'extra' }], /\b3\b/],
      ['duplicate ordinal', [{ ordinal: 1, answer: A1 }, { ordinal: 1, answer: 'another try' }, { ordinal: 2, answer: A2 }], /\b1\b/],
      ['blank answer', [{ ordinal: 1, answer: '   ' }, { ordinal: 2, answer: A2 }], /\b1\b/],
    ];
    for (const [label, answers, namesOrdinal] of violations) {
      const err = capture(() => stories.transition(story.id, { event: 'answer_clarifications', planVersion: 1, answers, expectedVersion: version }));
      expect(err, label).toBeInstanceOf(ApiHttpError);
      const httpErr = err as ApiHttpError;
      expect(httpErr.statusCode, label).toBe(409);
      expect(httpErr.code, label).toBe('GUARD_FAILED');
      // The guard reason must name the offending ordinals (spec §17.2 / plan assumption C3).
      const reasons = (httpErr.failedGuards ?? []).map((g) => g.reason).join('; ');
      expect(reasons, `guard reason for ${label} must name the offending ordinal (got: ${reasons})`).toMatch(namesOrdinal);

      // Nothing persisted: answers stay open, the story is unchanged, no transition landed.
      expect(clarificationRows(r1.planId!).every((c) => c.answer === null && c.answeredAt === null), label).toBe(true);
      expect(storyRow(story.id), label).toMatchObject({ status: 'NEW', planningStatus: 'needs_clarification', statusVersion: version });
      expect(planJobs(story.id), label).toHaveLength(0);
    }
    expect(transitionEvents(story.id)).toHaveLength(0);
  });

  test('AC3 — reject_plan persists feedback and re-plans with it (twice, without idempotency collisions); wrong versions are refused untouched', async () => {
    const { story, planner, runner, prompts } = setup([
      planWithoutQuestions('Buffered export endpoint'),
      planWithoutQuestions('Streaming export endpoint'),
      planWithoutQuestions('Streaming export with progress endpoint'),
    ]);
    const r1 = await planner.planStory({ storyId: story.id });
    expect(r1.ok).toBe(true);
    expect(storyRow(story.id).planningStatus).toBe('plan_proposed');

    // First rejection of v1 with feedback.
    const dto = stories.transition(story.id, { event: 'reject_plan', planVersion: 1, feedback: FEEDBACK, expectedVersion: storyRow(story.id).statusVersion });
    expect(dto).toMatchObject({ status: 'NEW', planningStatus: 'planning' });
    expect(planRows(story.id)[0]).toMatchObject({ version: 1, status: 'rejected', rejectionFeedback: FEEDBACK });

    await sleep(5); // keep planner runs in distinct milliseconds (Date.now()-based run ids)
    await runner.tick();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain(FEEDBACK);
    expect(prompts[1]).toContain(FEEDBACK);

    // Second rejection of the re-proposed v2 — the collision case the versioned discovery key exists for.
    const dto2 = stories.transition(story.id, { event: 'reject_plan', planVersion: 2, feedback: FEEDBACK_2, expectedVersion: storyRow(story.id).statusVersion });
    expect(dto2).toMatchObject({ status: 'NEW', planningStatus: 'planning' });

    await sleep(5);
    await runner.tick();

    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(FEEDBACK_2);

    // Both re-plan jobs ran to completion under distinct, version-keyed idempotency keys.
    const jobs = planJobs(story.id);
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([`auto_plan_${story.id}_${story.revision}_v2`, `auto_plan_${story.id}_${story.revision}_v3`]);

    // History: v1 and v2 rejected with their feedback, v3 proposed, story parked on v3.
    const rows = planRows(story.id);
    expect(rows.map((p) => [p.version, p.status, p.rejectionFeedback])).toEqual([
      [1, 'rejected', FEEDBACK],
      [2, 'rejected', FEEDBACK_2],
      [3, 'proposed', null],
    ]);
    expect(storyRow(story.id)).toMatchObject({ status: 'NEW', planningStatus: 'plan_proposed', activePlanId: rows[2]!.id });

    // Rejecting a non-proposed / wrong-version plan is refused and changes nothing.
    const eventsBefore = transitionEvents(story.id).length;
    for (const wrongVersion of [1, 2, 99]) {
      const err = capture(() =>
        stories.transition(story.id, { event: 'reject_plan', planVersion: wrongVersion, feedback: 'try to reject again', expectedVersion: storyRow(story.id).statusVersion }),
      );
      expect(err, `rejecting planVersion ${wrongVersion}`).toBeInstanceOf(ApiHttpError);
      const httpErr = err as ApiHttpError;
      expect(httpErr.statusCode).toBe(409);
      expect(httpErr.code).toBe('GUARD_FAILED');
    }
    expect(planRows(story.id).map((p) => [p.version, p.status, p.rejectionFeedback])).toEqual([
      [1, 'rejected', FEEDBACK],
      [2, 'rejected', FEEDBACK_2],
      [3, 'proposed', null],
    ]);
    expect(storyRow(story.id)).toMatchObject({ status: 'NEW', planningStatus: 'plan_proposed' });
    expect(transitionEvents(story.id)).toHaveLength(eventsBefore);
    expect(planJobs(story.id)).toHaveLength(2); // no extra re-plan enqueued by the refused attempts
  });

  test('AC4 — after the re-plan, approve_plan (T1) reaches READY and the v1 rows keep their answered history untouched', async () => {
    const { story, planner, runner } = setup([planWithQuestions, planWithoutQuestions('Streaming export endpoint')]);
    const r1 = await planner.planStory({ storyId: story.id, autoAccept: true });
    expect(r1.ok).toBe(true);
    const planIdV1 = r1.planId!;
    stories.transition(story.id, {
      event: 'answer_clarifications',
      planVersion: 1,
      answers: [
        { ordinal: 1, answer: A1 },
        { ordinal: 2, answer: A2 },
      ],
      expectedVersion: storyRow(story.id).statusVersion,
    });

    await sleep(5); // keep planner runs in distinct milliseconds (Date.now()-based run ids)
    await runner.tick();

    const v2 = planRows(story.id).find((p) => p.version === 2);
    expect(v2).toMatchObject({ status: 'proposed' });

    const dto = stories.transition(story.id, { event: 'approve_plan', planVersion: 2, expectedVersion: storyRow(story.id).statusVersion });

    expect(dto).toMatchObject({ status: 'READY', planningStatus: 'plan_approved', activePlanVersion: 2 });
    expect(planRows(story.id).find((p) => p.version === 2)).toMatchObject({ status: 'approved', approvedBy: 'human' });
    expect(clarificationRows(v2!.id)).toEqual([]);

    // Immutable history: v1 stays the answered proposal — not approved, not rejected, not superseded.
    expect(planRows(story.id).find((p) => p.version === 1)).toMatchObject({ status: 'proposed', approvedBy: null, approvedAt: null, rejectionFeedback: null });
    expect(clarificationRows(planIdV1)).toEqual([
      expect.objectContaining({ ordinal: 1, question: Q1, answer: A1 }),
      expect.objectContaining({ ordinal: 2, question: Q2, answer: A2 }),
    ]);
    expect(clarificationRows(planIdV1).every((c) => c.answeredAt instanceof Date)).toBe(true);
  });
});
