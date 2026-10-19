import { durableJobs, mergeApprovals } from '@aik/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiHttpError } from '../src/api/errors.ts';
import { EventBus } from '../src/events/bus.ts';
import type { LocalMerger } from '../src/git/merger.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { StoryService } from '../src/stories/service.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

const fakeMerger = {} as LocalMerger;

/** Runs fn and returns the ApiHttpError it threw (fails the test when nothing is thrown). */
const failureOf = (fn: () => unknown): ApiHttpError => {
  try {
    fn();
  } catch (e) {
    return e as ApiHttpError;
  }
  throw new Error('expected the call to throw an ApiHttpError');
};

describe('approve_merge request validation', () => {
  let t: ReturnType<typeof createTestDb>;
  let queue: JobQueue;
  let stories: StoryService;

  beforeEach(() => {
    t = createTestDb();
    const bus = new EventBus();
    const workflow = new WorkflowService({ db: t.db, bus });
    queue = new JobQueue(t.db);
    stories = new StoryService({ db: t.db, workflow, bus, queue, merger: fakeMerger });
  });

  afterEach(() => {
    t.close();
  });

  const awaitingMergeStory = (sha: string) => {
    const project = seedProject(t.db);
    return seedStory(t.db, project.id, {
      key: 'APR-1',
      title: 'Approve me',
      status: 'AWAITING_MERGE',
      candidateSha: sha,
      candidateTree: 'b'.repeat(40),
      statusVersion: 4,
    });
  };

  test('records a SHA-bound approval and enqueues the merge job', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);

    // `method` is accepted by the contract but ignored: ProjectSettings.mergeMethod stays authoritative.
    const dto = stories.transition(story.id, { event: 'approve_merge', sha, expectedVersion: 4, method: 'squash' }, 'merge-approval-1');

    expect(dto.status).toBe('AWAITING_MERGE');
    const approval = t.db.select().from(mergeApprovals).where(eq(mergeApprovals.storyId, story.id)).get();
    expect(approval).toMatchObject({ kind: 'merge', commitSha: sha, approver: 'local-user' });
    const jobs = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'merge', status: 'queued', sideEffecting: true });
    expect(jobs[0]?.payload).toEqual({ sha, approvalId: approval!.id });
  });

  test('retries a failed merge when it is approved again', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);
    const request = { event: 'approve_merge' as const, sha, expectedVersion: 4 };

    stories.transition(story.id, request, 'merge-approval-fail');
    const first = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).get()!;
    const leased = queue.claim('heavy')!;
    expect(queue.fail(leased.id, leased.leaseToken, 'dirty checkout')).toBe('failed');

    stories.transition(story.id, request, 'merge-approval-retry');

    const jobs = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === first.id)?.status).toBe('failed');
    expect(jobs.find((j) => j.id !== first.id)).toMatchObject({ kind: 'merge', status: 'queued' });
    // The retry job reuses the single SHA-bound approval row (the insert conflicts away).
    const approval = t.db.select().from(mergeApprovals).where(eq(mergeApprovals.storyId, story.id)).get()!;
    expect(jobs.find((j) => j.id !== first.id)?.payload).toEqual({ sha, approvalId: approval.id });
  });

  test('repeating the same approval request does not enqueue a second merge job', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);
    const request = { event: 'approve_merge' as const, sha, expectedVersion: 4 };

    stories.transition(story.id, request, 'merge-approval-same');
    stories.transition(story.id, request, 'merge-approval-same');

    expect(t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all()).toHaveLength(1);
  });

  test('a new approval key does not stack a second job while the first is queued or leased', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);
    const request = { event: 'approve_merge' as const, sha, expectedVersion: 4 };

    stories.transition(story.id, request, 'merge-approval-first');
    expect(t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all()).toHaveLength(1);

    // A different idempotency key is a distinct API request, but the queued job already covers it.
    const dto = stories.transition(story.id, request, 'merge-approval-second');
    expect(dto.status).toBe('AWAITING_MERGE');
    expect(t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all()).toHaveLength(1);

    // Nor while the runner holds the lease on the merge job.
    const leased = queue.claim('heavy')!;
    expect(leased.kind).toBe('merge');
    const again = stories.transition(story.id, request, 'merge-approval-third');
    expect(again.status).toBe('AWAITING_MERGE');
    const jobs = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: leased.id, status: 'leased' });
  });

  test('treats a merge job whose lease expired as not live, so a retry can be enqueued', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);
    const request = { event: 'approve_merge' as const, sha, expectedVersion: 4 };

    stories.transition(story.id, request, 'merge-approval-lease-1');
    const leased = queue.claim('heavy')!;
    expect(leased.kind).toBe('merge');

    // The runner lost the job (crash/hang): the lease is dead even though the row still says leased.
    t.db
      .update(durableJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(durableJobs.id, leased.id))
      .run();

    const dto = stories.transition(story.id, request, 'merge-approval-lease-2');
    expect(dto.status).toBe('AWAITING_MERGE');
    const jobs = t.db.select().from(durableJobs).where(eq(durableJobs.storyId, story.id)).all();
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === leased.id)?.status).toBe('leased');
    expect(jobs.find((j) => j.id !== leased.id)).toMatchObject({ kind: 'merge', status: 'queued' });
  });

  test('refuses approve_merge when the merge pipeline is not installed', () => {
    const sha = 'a'.repeat(40);
    const story = awaitingMergeStory(sha);
    const request = { event: 'approve_merge' as const, sha, expectedVersion: 4 };
    const bus = new EventBus();
    const workflow = new WorkflowService({ db: t.db, bus });

    const noMerger = new StoryService({ db: t.db, workflow, bus, queue });
    const withoutMerger = failureOf(() => noMerger.transition(story.id, request, 'merge-approval-no-merger'));

    const noQueue = new StoryService({ db: t.db, workflow, bus, merger: fakeMerger });
    const withoutQueue = failureOf(() => noQueue.transition(story.id, request, 'merge-approval-no-queue'));

    for (const err of [withoutMerger, withoutQueue]) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('GUARD_FAILED');
      expect(err.failedGuards).toEqual([
        { guard: 'feature_unavailable', reason: 'approve_merge is handled by the merge pipeline, which is not installed in this build' },
      ]);
    }
    // The guard fires before any approval is recorded or any job is enqueued.
    expect(t.db.select().from(mergeApprovals).all()).toHaveLength(0);
    expect(t.db.select().from(durableJobs).all()).toHaveLength(0);
  });

  test('refuses a sha that is not the current candidate', () => {
    const story = awaitingMergeStory('a'.repeat(40));
    expect(() =>
      stories.transition(story.id, { event: 'approve_merge', sha: 'c'.repeat(40), expectedVersion: 4 }),
    ).toThrow(ApiHttpError);
    expect(t.db.select().from(mergeApprovals).all()).toHaveLength(0);
  });

  test('refuses approval while the story is not AWAITING_MERGE', () => {
    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id, {
      key: 'APR-2',
      title: 'Wrong state',
      status: 'READY_FOR_REVIEW',
      candidateSha: 'a'.repeat(40),
      statusVersion: 2,
    });
    expect(() =>
      stories.transition(story.id, { event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 2 }),
    ).toThrow(/AWAITING_MERGE/);
  });

  test('refuses a stale expectedVersion', () => {
    const story = awaitingMergeStory('a'.repeat(40));
    expect(() =>
      stories.transition(story.id, { event: 'approve_merge', sha: 'a'.repeat(40), expectedVersion: 1 }),
    ).toThrow(/changed since/);
  });
});
