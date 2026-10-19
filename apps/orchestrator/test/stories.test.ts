// apps/orchestrator/test/stories.test.ts
import { agentRuns, clarifications, plans, reviewFindings, reviews, storyEvents, verificationChecks, verificationRuns } from '@aik/db';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiHttpError } from '../src/api/errors.ts';
import { buildTestApp } from './helpers/app.ts';
import { forceStory, seedPlan } from './helpers/db.ts';
import { makeTempRepo } from './helpers/temp.ts';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let projectId: number;

beforeEach(async () => {
  ctx = await buildTestApp();
  projectId = (await ctx.inject('POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() })).json().id;
});
afterEach(async () => {
  await ctx.app.close();
  ctx.t.close();
});

const createStory = async (body: object) => (await ctx.inject('POST', `/projects/${projectId}/stories`, body)).json();

describe('stories CRUD', () => {
  it('creates stories with sequential keys, criteria and defaults', async () => {
    const r = await ctx.inject('POST', `/projects/${projectId}/stories`, { title: 'Inventory module', description: 'CRUD', acceptanceCriteria: ['Create works', 'Search works'] });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      key: 'INV-1', status: 'NEW', statusVersion: 0, revision: 1, priority: 'P2', planningStatus: 'none', activePlanVersion: null,
      attempts: { used: 0, max: 3 }, blocked: null, acceptanceCriteria: [{ ordinal: 1, text: 'Create works' }, { ordinal: 2, text: 'Search works' }],
    });
    expect((await createStory({ title: 'Second' })).key).toBe('INV-2');
  });

  it('rejects unknown dependencies', async () => {
    const r = await ctx.inject('POST', `/projects/${projectId}/stories`, { title: 'X', dependsOn: ['INV-99'] });
    expect(r.statusCode).toBe(400);
  });

  it('lists with status, label, search and sort filters', async () => {
    await createStory({ title: 'Alpha', labels: ['backend'], priority: 'P1' });
    await createStory({ title: 'Beta', labels: ['ui'], priority: 'P0' });
    const all = (await ctx.inject('GET', `/projects/${projectId}/stories?sort=priority`)).json();
    expect(all.map((s: { title: string }) => s.title)).toEqual(['Beta', 'Alpha']);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?label=ui`)).json()).toHaveLength(1);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?q=alp`)).json()).toHaveLength(1);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?status=NEW,READY`)).json()).toHaveLength(2);
    expect((await ctx.inject('GET', `/projects/${projectId}/stories?status=BOGUS`)).statusCode).toBe(400);
  });

  it('search treats % and _ literally and round-trips emoji', async () => {
    await createStory({ title: '100% coverage 🚀' });
    await createStory({ title: 'snake_case naming' });
    await createStory({ title: 'plain title' });
    const pct = (await ctx.inject('GET', `/projects/${projectId}/stories?q=${encodeURIComponent('%')}`)).json();
    expect(pct.map((s: { title: string }) => s.title)).toEqual(['100% coverage 🚀']);
    const us = (await ctx.inject('GET', `/projects/${projectId}/stories?q=${encodeURIComponent('_')}`)).json();
    expect(us.map((s: { title: string }) => s.title)).toEqual(['snake_case naming']);
  });
});

describe('PATCH /stories/:id', () => {
  it('edits the definition in NEW: bumps revision and version', async () => {
    const s = await createStory({ title: 'Old', acceptanceCriteria: ['A'] });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, title: 'New', acceptanceCriteria: ['A2', 'B2'] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ title: 'New', revision: 2, statusVersion: 1, acceptanceCriteria: [{ text: 'A2' }, { text: 'B2' }] });
  });

  it('rejects a stale expectedVersion', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 7, title: 'Y' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('editing criteria in READY moves the story back to NEW and supersedes the plan (T2)', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedPlan(ctx.t.db, s.id, { status: 'approved' });
    forceStory(ctx.t.db, s.id, { status: 'READY', planningStatus: 'plan_approved' });
    const r = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, acceptanceCriteria: ['A', 'B'] });
    expect(r.json()).toMatchObject({ status: 'NEW', planningStatus: 'none', revision: 2 });
    expect(ctx.t.db.select().from(plans).get()?.status).toBe('superseded');
  });

  it('refuses definition edits while work is active but allows labels', async () => {
    const s = await createStory({ title: 'X' });
    forceStory(ctx.t.db, s.id, { status: 'IN_PROGRESS' });
    const bad = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, description: 'changed' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.failedGuards[0].guard).toBe('editable_state');
    const ok = await ctx.inject('PATCH', `/stories/${s.id}`, { expectedVersion: 0, labels: ['urgent'] });
    expect(ok.json()).toMatchObject({ labels: ['urgent'], statusVersion: 1 });
  });

  it('rejects dependency cycles with the cycle path', async () => {
    const a = await createStory({ title: 'A' });
    const b = await createStory({ title: 'B', dependsOn: [a.key] });
    const r = await ctx.inject('PATCH', `/stories/${a.id}`, { expectedVersion: 0, dependsOn: [b.key] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain('INV-1 → INV-2 → INV-1');
  });
});

describe('POST /stories/:id/transitions', () => {
  it('cancels and replays the same idempotency key without a second transition', async () => {
    const s = await createStory({ title: 'X' });
    const key = crypto.randomUUID();
    const a = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'cancel', expectedVersion: 0 }, key);
    const b = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'cancel', expectedVersion: 0 }, key);
    expect(a.json()).toMatchObject({ status: 'CANCELLED' });
    expect(b.json()).toEqual(a.json());
    expect(ctx.t.db.select().from(storyEvents).all().filter((e) => e.type === 'transition')).toHaveLength(1);
  });

  it('explains why a plan cannot be approved yet', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'approve_plan', planVersion: 1, expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('planning_status');
  });

  it('reports events whose components are not installed yet', async () => {
    const s = await createStory({ title: 'X' });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards[0].guard).toBe('feature_unavailable');
  });

  it('request_changes records a human review and moves AWAITING_MERGE → REWORK', async () => {
    const s = await createStory({ title: 'X' });
    forceStory(ctx.t.db, s.id, { status: 'AWAITING_MERGE', candidateSha: 'a'.repeat(40) });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'request_changes', sha: 'a'.repeat(40), findings: [{ text: 'Handle empty input' }], expectedVersion: 0 });
    expect(r.json()).toMatchObject({ status: 'REWORK' });
    expect(ctx.t.db.select().from(reviews).get()).toMatchObject({ actor: 'human', verdict: 'CHANGES_REQUESTED', commitSha: 'a'.repeat(40) });
  });
});

describe('plan feedback: reject_plan and answer_clarifications (EXE-7)', () => {
  /** Puts the story's v1 plan in the requested planning state, optionally with open questions. */
  const seedProposedPlan = (storyId: number, planningStatus: 'plan_proposed' | 'needs_clarification', questions: string[] = []) => {
    const plan = seedPlan(ctx.t.db, storyId); // version 1, proposed
    if (questions.length > 0) {
      ctx.t.db.insert(clarifications).values(questions.map((q, i) => ({ planId: plan.id, ordinal: i + 1, question: q }))).run();
    }
    forceStory(ctx.t.db, storyId, { planningStatus });
    return plan;
  };

  it('reject_plan marks the plan rejected with feedback and returns the story to planning', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'plan_proposed');
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'reject_plan', planVersion: 1, feedback: 'Batch the inserts instead', expectedVersion: 0 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'NEW', planningStatus: 'planning', statusVersion: 1 });
    expect(ctx.t.db.select().from(plans).get()).toMatchObject({ status: 'rejected', rejectionFeedback: 'Batch the inserts instead' });
  });

  it('answer_clarifications persists every answer and returns the story to planning', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Which database?', 'Is auth needed?']);
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, {
      event: 'answer_clarifications', planVersion: 1,
      answers: [{ ordinal: 1, answer: 'SQLite' }, { ordinal: 2, answer: 'No auth' }], expectedVersion: 0,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'NEW', planningStatus: 'planning', statusVersion: 1 });
    const rows = ctx.t.db.select().from(clarifications).all().sort((a, b) => a.ordinal - b.ordinal);
    expect(rows[0]).toMatchObject({ ordinal: 1, answer: 'SQLite', answeredAt: expect.any(Date) });
    expect(rows[1]).toMatchObject({ ordinal: 2, answer: 'No auth', answeredAt: expect.any(Date) });
  });

  it('answer_clarifications with a missing ordinal is GUARD_FAILED naming it', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?', 'Q2?']);
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'answer_clarifications', planVersion: 1, answers: [{ ordinal: 1, answer: 'A1' }], expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('GUARD_FAILED');
    expect(r.json().error.failedGuards).toEqual([{ guard: 'clarifications', reason: expect.stringContaining('missing ordinals 2') }]);
    expect(ctx.t.db.select().from(clarifications).all().every((c) => c.answer === null)).toBe(true);
  });

  it('answer_clarifications with an unknown ordinal is GUARD_FAILED naming it', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?', 'Q2?']);
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, {
      event: 'answer_clarifications', planVersion: 1,
      answers: [{ ordinal: 1, answer: 'A1' }, { ordinal: 2, answer: 'A2' }, { ordinal: 3, answer: 'A3' }], expectedVersion: 0,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards).toEqual([{ guard: 'clarifications', reason: expect.stringContaining('unknown ordinals 3') }]);
    expect(ctx.t.db.select().from(clarifications).all().every((c) => c.answer === null)).toBe(true);
  });

  it('answer_clarifications with a duplicate ordinal is GUARD_FAILED naming it', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?', 'Q2?']);
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, {
      event: 'answer_clarifications', planVersion: 1,
      answers: [{ ordinal: 1, answer: 'A1' }, { ordinal: 1, answer: 'A1 again' }], expectedVersion: 0,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards).toEqual([{ guard: 'clarifications', reason: expect.stringContaining('duplicate ordinals 1') }]);
    expect(ctx.t.db.select().from(clarifications).all().every((c) => c.answer === null)).toBe(true);
  });

  it('answer_clarifications with a whitespace-only answer is GUARD_FAILED naming the ordinal (service-level; the HTTP schema trims first)', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?', 'Q2?']);
    try {
      ctx.services.stories.transition(s.id, {
        event: 'answer_clarifications', planVersion: 1,
        answers: [{ ordinal: 1, answer: 'A1' }, { ordinal: 2, answer: '   ' }], expectedVersion: 0,
      });
      expect.unreachable('the service must refuse empty answers');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiHttpError);
      const err = e as ApiHttpError;
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('GUARD_FAILED');
      expect(err.failedGuards?.[0]?.guard).toBe('clarifications');
      expect(err.failedGuards?.[0]?.reason).toContain('empty answers for ordinals 2');
    }
    expect(ctx.t.db.select().from(clarifications).all().every((c) => c.answer === null)).toBe(true);
  });

  it('answer_clarifications while already answered (stale tab) is refused by the machine planning_status guard, not the ordinal validator (QA D2)', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?']);
    const first = await ctx.inject('POST', `/stories/${s.id}/transitions`, {
      event: 'answer_clarifications', planVersion: 1, answers: [{ ordinal: 1, answer: 'A1' }], expectedVersion: 0,
    });
    expect(first.statusCode).toBe(200);
    // A stale tab re-submits after the story already left needs_clarification; the machine's
    // clearer planning_status guard must surface, not the ordinal validator's message.
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, {
      event: 'answer_clarifications', planVersion: 1, answers: [{ ordinal: 1, answer: 'A1' }], expectedVersion: 1,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('planning_status');
  });

  it('a replayed answer_clarifications request with the same idempotency key returns the duplicate outcome instead of a guard error (QA D1)', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?']);
    const key = '0d1f8ac0-1111-4222-8333-444455556666';
    const req = { event: 'answer_clarifications' as const, planVersion: 1, answers: [{ ordinal: 1, answer: 'A1' }], expectedVersion: 0 };
    const first = ctx.services.stories.transition(s.id, req, key);
    expect(first.planningStatus).toBe('planning');
    // Crash-window replay (the API idempotency store was lost): the same key must return the
    // recorded duplicate transition, never a fresh validation/guard error.
    const second = ctx.services.stories.transition(s.id, req, key);
    expect(second.planningStatus).toBe('planning');
    expect(second.statusVersion).toBe(first.statusVersion);
    expect(ctx.t.db.select().from(clarifications).where(eq(clarifications.answer, 'A1')).all()).toHaveLength(1);
  });

  it('reject_plan for a wrong planVersion is refused by the plan guard', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'plan_proposed');
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'reject_plan', planVersion: 2, feedback: 'Stale plan', expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('plan_version');
    expect(ctx.t.db.select().from(plans).get()?.status).toBe('proposed');
  });

  it('reject_plan is refused outside NEW', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    const plan = seedPlan(ctx.t.db, s.id, { status: 'approved' });
    forceStory(ctx.t.db, s.id, { status: 'READY', planningStatus: 'plan_approved', activePlanId: plan.id });
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'reject_plan', planVersion: 1, feedback: 'Too late', expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('state');
  });

  it('answer_clarifications for a wrong planVersion is refused by the plan guard', async () => {
    const s = await createStory({ title: 'X', description: 'd', acceptanceCriteria: ['A'] });
    seedProposedPlan(s.id, 'needs_clarification', ['Q1?']);
    const r = await ctx.inject('POST', `/stories/${s.id}/transitions`, { event: 'answer_clarifications', planVersion: 2, answers: [{ ordinal: 1, answer: 'A1' }], expectedVersion: 0 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.failedGuards.map((g: { guard: string }) => g.guard)).toContain('plan_version');
    expect(ctx.t.db.select().from(clarifications).all().every((c) => c.answer === null)).toBe(true);
  });
});

describe('GET /stories/:id/agent-run', () => {
  it('returns run details and messages for a story', async () => {
    const s = await createStory({ title: 'Task with run' });
    const emptyRes = await ctx.inject('GET', `/stories/${s.id}/agent-run`);
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json()).toEqual({ run: null, messages: [] });

    ctx.t.db.insert(agentRuns).values({
      storyId: s.id,
      role: 'planner',
      attempt: 1,
      promptVersion: '1.0',
      opencodeVersion: '2.0.32',
      status: 'running',
      idempotencyKey: 'test_run_1',
      startedAt: new Date(),
    }).run();

    const withRunRes = await ctx.inject('GET', `/stories/${s.id}/agent-run`);
    expect(withRunRes.statusCode).toBe(200);
    expect(withRunRes.json().run).toMatchObject({
      role: 'planner',
      status: 'running',
      model: 'OpenCode',
    });
  });
});

describe('GET /stories/:id/details', () => {
  it('exposes plan, verification and review findings, flagging unverified locations', async () => {
    const s = await createStory({ title: 'Detail me', description: 'd', acceptanceCriteria: ['It works'] });
    const sha = 'a'.repeat(40);
    const plan = seedPlan(ctx.t.db, s.id, { status: 'approved' });
    forceStory(ctx.t.db, s.id, { status: 'READY_FOR_REVIEW', candidateSha: sha, candidateTree: 'b'.repeat(40), activePlanId: plan.id });

    const run = ctx.t.db.insert(verificationRuns).values({
      storyId: s.id, commitSha: sha, trigger: 'candidate', status: 'failed', startedAt: new Date(), endedAt: new Date(),
    }).returning().get();
    ctx.t.db.insert(verificationChecks).values({
      verificationRunId: run.id, checkKey: 'test', mandatory: true, command: 'npm test', cwd: 'wt', status: 'failed', exitCode: 1, startedAt: new Date(), endedAt: new Date(),
    }).run();

    const review = ctx.t.db.insert(reviews).values({
      storyId: s.id, commitSha: sha, actor: 'agent', rawVerdict: 'CHANGES_REQUESTED', verdict: 'CHANGES_REQUESTED',
      summary: 'Fix it',
      raw: { schemaVersion: 1, verdict: 'CHANGES_REQUESTED', summary: 'Fix it', acChecklist: [], findings: [], priorFindings: [] },
      createdAt: new Date(),
    }).returning().get();
    ctx.t.db.insert(reviewFindings).values([
      { reviewId: review.id, findingKey: 'F-1', severity: 'high', category: 'correctness', filePath: 'ghost.ts', evidence: 'e', explanation: 'x', recommendation: 'r', blocking: true, locationVerified: false },
      { reviewId: review.id, findingKey: 'F-2', severity: 'info', category: 'tests', filePath: 'src/a.ts', evidence: 'e', explanation: 'y', recommendation: 'r2', blocking: false },
    ]).run();

    const r = await ctx.inject('GET', `/stories/${s.id}/details`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.plan).toMatchObject({ summary: 'Plan' });
    expect(body.verification).toMatchObject({ status: 'failed', commitSha: sha });
    expect(body.verification.checks[0]).toMatchObject({ key: 'test', status: 'failed', exitCode: 1 });
    expect(body.review.findings).toEqual([
      expect.objectContaining({ id: 'F-1', file: 'ghost.ts', unverifiedLocation: true }),
      expect.objectContaining({ id: 'F-2', file: 'src/a.ts', unverifiedLocation: false }),
    ]);
    expect(body.diff).toBeNull();
  });
});
