// apps/orchestrator/test/stories.test.ts
import { agentRuns, plans, reviews, storyEvents } from '@aik/db';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
