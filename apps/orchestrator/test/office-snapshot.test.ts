import { OfficeSnapshot } from '@aik/contracts';
import { agentRuns, storyEvents, verificationChecks, verificationRuns } from '@aik/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { OfficeRoomService } from '../src/office/room-service.ts';
import { buildOfficeSnapshot } from '../src/office/snapshot.ts';
import { createTestDb, forceStory, seedProject, seedStory } from './helpers/db.ts';

const NOW = new Date(2026, 10, 8, 15, 0, 0).getTime();
const SHA = 'a'.repeat(40);
const d = (ms: number) => new Date(ms);

describe('buildOfficeSnapshot', () => {
  let t: ReturnType<typeof createTestDb>;
  let svc: OfficeRoomService;
  let project: ReturnType<typeof seedProject>;
  let roomId: number;
  beforeEach(() => {
    t = createTestDb();
    svc = new OfficeRoomService({ db: t.db, bus: new EventBus() });
    project = seedProject(t.db, { key: 'ALPHA' });
    roomId = svc.onProjectCreated(project).id;
  });
  const snap = () => OfficeSnapshot.parse(buildOfficeSnapshot(t.db, () => NOW));
  const run = (storyId: number, over: Partial<typeof agentRuns.$inferInsert> = {}) =>
    t.db.insert(agentRuns).values({ storyId, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '1', status: 'running', idempotencyKey: `k${Math.random()}`, startedAt: d(NOW - 60_000), ...over }).returning().get();

  it('board counts every status, zeros included', () => {
    const a = seedStory(t.db, project.id);
    const b = seedStory(t.db, project.id);
    forceStory(t.db, a.id, { status: 'READY' });
    forceStory(t.db, b.id, { status: 'READY' });
    const r = snap().rooms[0]!;
    expect(r.roomId).toBe(roomId);
    expect(Object.keys(r.board)).toHaveLength(10);
    expect(r.board.READY).toBe(2);
    expect(r.board.DONE).toBe(0);
  });

  it('lists blocked stories with reason', () => {
    const s = seedStory(t.db, project.id, { key: 'ALPHA-2', title: 'Stuck' });
    forceStory(t.db, s.id, { status: 'BLOCKED', blockedReason: 'retry_limit' });
    expect(snap().rooms[0]!.blocked).toEqual([{ storyId: s.id, storyKey: 'ALPHA-2', title: 'Stuck', reason: 'retry_limit' }]);
  });

  it('doneToday counts stories that entered DONE since local midnight only', () => {
    const a = seedStory(t.db, project.id);
    const b = seedStory(t.db, project.id);
    const ev = (storyId: number, at: number) => t.db.insert(storyEvents).values({ storyId, type: 'status', toStatus: 'DONE', actor: 'system', createdAt: d(at) }).run();
    ev(a.id, new Date(2026, 10, 8, 0, 30).getTime());
    ev(a.id, new Date(2026, 10, 8, 1, 30).getTime());
    ev(b.id, new Date(2026, 10, 7, 23, 59).getTime());
    expect(snap().rooms[0]!.doneToday).toBe(1);
  });

  it('activeRuns lists running runs with role and story key', () => {
    const s = seedStory(t.db, project.id, { key: 'ALPHA-1' });
    run(s.id);
    run(s.id, { status: 'succeeded', endedAt: d(NOW - 1000) });
    const r = snap().rooms[0]!;
    expect(r.activeRuns).toHaveLength(1);
    expect(r.activeRuns[0]).toMatchObject({ role: 'implementer', storyKey: 'ALPHA-1' });
  });

  it('lastFinished keeps the latest run per story+role within 10 minutes', () => {
    const s = seedStory(t.db, project.id);
    run(s.id, { status: 'failed', endedAt: d(NOW - 120_000) });
    const newer = run(s.id, { status: 'succeeded', endedAt: d(NOW - 30_000) });
    run(s.id, { role: 'reviewer', status: 'failed', endedAt: d(NOW - 11 * 60_000) });
    run(s.id, { role: 'planner', status: 'cancelled', endedAt: d(NOW - 1000) });
    const lf = snap().rooms[0]!.lastFinished;
    expect(lf).toHaveLength(1);
    expect(lf[0]).toMatchObject({ runId: newer.id, status: 'succeeded', role: 'implementer' });
  });

  it('verification includes failed checks with a one-line summary <= 200 chars', () => {
    const s = seedStory(t.db, project.id, { key: 'ALPHA-3' });
    forceStory(t.db, s.id, { status: 'TESTING' });
    const old = t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: SHA, trigger: 'candidate', status: 'passed', startedAt: d(NOW - 9000) }).returning().get();
    const vr = t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: SHA, trigger: 'candidate', status: 'failed', startedAt: d(NOW - 5000) }).returning().get();
    t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: SHA, trigger: 'postmerge', status: 'passed', startedAt: d(NOW - 1000) }).run();
    const chk = (runId: number, checkKey: string, status: 'passed' | 'failed', outputTail: string | null) =>
      t.db.insert(verificationChecks).values({ verificationRunId: runId, checkKey, mandatory: true, command: 'x', cwd: '.', status, outputTail, startedAt: d(NOW - 4000), endedAt: d(NOW - 3000) }).run();
    chk(old.id, 'lint', 'passed', 'ok');
    chk(vr.id, 'lint', 'failed', `first\n${'e'.repeat(500)}\n\n`);
    chk(vr.id, 'test', 'passed', null);
    const v = snap().rooms[0]!.verification;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ storyKey: 'ALPHA-3', verificationRunId: vr.id, status: 'failed' });
    expect(v[0]!.checks.find((c) => c.checkKey === 'lint')).toMatchObject({ status: 'failed' });
    expect(v[0]!.checks.find((c) => c.checkKey === 'lint')!.summary).toBe('e'.repeat(200));
    expect(v[0]!.checks.find((c) => c.checkKey === 'test')!.summary).toBe('');
    // Duration (endedAt - startedAt) and mandatory flag ride along for the QA test board / QA state.
    expect(v[0]!.checks.find((c) => c.checkKey === 'lint')).toMatchObject({ durationMs: 1000, mandatory: true });
  });

  it('ignores verification for stories not in TESTING or REWORK', () => {
    const s = seedStory(t.db, project.id);
    t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: SHA, trigger: 'candidate', status: 'passed', startedAt: d(NOW) }).run();
    expect(snap().rooms[0]!.verification).toEqual([]);
  });

  it('archived rooms are not in the snapshot', () => {
    svc.onProjectDeleted(project.id);
    expect(snap().rooms).toHaveLength(0);
  });
});
