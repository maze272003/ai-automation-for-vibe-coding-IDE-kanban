import { mergeApprovals, merges, userStories, verificationChecks, verificationRuns } from '@aik/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

/**
 * T10 / invariant I1: AWAITING_MERGE -> DONE must require real evidence — a SHA-bound approval,
 * a succeeded merge, a matching merged SHA that contains the candidate, and a PASSED post-merge
 * verification whose mandatory check rows actually exist and actually passed.
 */
describe('T10 merge evidence guards', () => {
  let t: ReturnType<typeof createTestDb>;
  let workflow: WorkflowService;
  let storyId: number;
  const candidate = 'a'.repeat(40);
  const merged = 'b'.repeat(40);

  beforeEach(() => {
    t = createTestDb();
    const bus = new EventBus();
    workflow = new WorkflowService({ db: t.db, bus });
    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, {
      key: 'TEN-1',
      title: 'Evidence',
      status: 'AWAITING_MERGE',
      candidateSha: candidate,
      candidateTree: 'c'.repeat(40),
    });
    storyId = story.id;
  });

  afterEach(() => {
    t.close();
  });

  const approve = () =>
    t.db.insert(mergeApprovals).values({ storyId, kind: 'merge', commitSha: candidate, approver: 'local-user', approvedAt: new Date() }).run();

  const recordMerge = () =>
    t.db
      .insert(merges)
      .values({
        storyId,
        method: 'local_merge',
        approvedSha: candidate,
        baseBefore: 'd'.repeat(40),
        baseAfter: merged,
        mergedSha: merged,
        status: 'succeeded',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

  const postMergeRun = (status: 'passed' | 'failed' | 'error') =>
    t.db
      .insert(verificationRuns)
      .values({ storyId, commitSha: merged, trigger: 'postmerge', status, startedAt: new Date(), endedAt: new Date() })
      .returning({ id: verificationRuns.id })
      .get()!;

  const transition = () =>
    workflow.transition({ storyId, event: { type: 'merge_completed', mergedSha: merged }, actor: 'system' });

  const status = () => t.db.select({ status: userStories.status }).from(userStories).where(eq(userStories.id, storyId)).get()?.status;

  test('refuses DONE without a human approval for the exact candidate', () => {
    recordMerge();
    postMergeRun('passed');

    const r = transition();

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failedGuards?.some((g) => g.guard === 'merge_approval')).toBe(true);
    expect(status()).toBe('AWAITING_MERGE');
  });

  test('refuses DONE when no merge is recorded', () => {
    approve();
    postMergeRun('passed');

    const r = transition();

    expect(r.ok === false && r.failedGuards?.some((g) => g.guard === 'merge')).toBe(true);
    expect(status()).toBe('AWAITING_MERGE');
  });

  test('a passed post-merge run without mandatory check rows is not evidence', () => {
    approve();
    recordMerge();
    postMergeRun('passed');

    const r = transition();

    expect(r.ok === false && r.failedGuards?.some((g) => g.guard === 'post_merge_checks')).toBe(true);
    expect(status()).toBe('AWAITING_MERGE');
  });

  test('a passed run with a failed mandatory check row is not evidence', () => {
    approve();
    recordMerge();
    const run = postMergeRun('passed');
    t.db
      .insert(verificationChecks)
      .values({
        verificationRunId: run.id,
        checkKey: 'test',
        mandatory: true,
        command: 'npm test',
        cwd: 'C:/repos/x',
        status: 'failed',
        exitCode: 1,
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    const r = transition();

    expect(r.ok === false && r.failedGuards?.some((g) => g.guard === 'post_merge_checks')).toBe(true);
    expect(status()).toBe('AWAITING_MERGE');
  });

  test('full evidence transitions the story to DONE', () => {
    approve();
    recordMerge();
    const run = postMergeRun('passed');
    t.db
      .insert(verificationChecks)
      .values({
        verificationRunId: run.id,
        checkKey: 'secrets',
        mandatory: true,
        command: 'internal:secrets',
        cwd: 'C:/repos/x',
        status: 'passed',
        startedAt: new Date(),
        endedAt: new Date(),
      })
      .run();

    const r = transition();

    expect(r.ok).toBe(true);
    expect(status()).toBe('DONE');
    expect(t.db.select({ mergedSha: userStories.mergedSha }).from(userStories).where(eq(userStories.id, storyId)).get()?.mergedSha).toBe(merged);
  });
});
