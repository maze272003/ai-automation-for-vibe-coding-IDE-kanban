import { agentRuns } from '@aik/db';
import { describe, expect, test } from 'vitest';
import { appendRunActivity, emitRunFinished, emitRunStarted, runEventInfo } from '../src/agents/run-events.ts';
import { readOutbox } from './helpers/outbox.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

describe('run-events', () => {
  test('emits run.started and run.finished with story/project context', () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-4' });
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'implementer', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `test_${story.id}`,
        startedAt: new Date(1_000),
      })
      .returning()
      .get();

    expect(runEventInfo(t.db, run.id)).toEqual({
      runId: run.id, storyId: story.id, storyKey: 'INV-4', projectKey: 'INV', role: 'implementer',
    });

    const now = new Date(1_234);
    emitRunStarted(t.db, now, run.id);
    emitRunFinished(t.db, now, run.id, 'succeeded', null);

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ topic: 'run.started', storyId: story.id, provenance: 'system' });
    expect(rows[0]?.data).toEqual({ runId: run.id, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV' });
    expect(rows[1]?.topic).toBe('run.finished');
    expect(rows[1]?.data).toEqual({
      runId: run.id, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV', status: 'succeeded',
    });
    t.close();
  });

  test('finished keeps a non-empty exitReason, drops empty ones; unknown run is a no-op', () => {
    const t = createTestDb();
    const project = seedProject(t.db);
    const story = seedStory(t.db, project.id);
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'planner', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'failed', idempotencyKey: `test2_${story.id}`,
        startedAt: new Date(1_000), endedAt: new Date(2_000),
      })
      .returning()
      .get();

    emitRunFinished(t.db, new Date(2_000), run.id, 'failed', 'provider down');
    emitRunStarted(t.db, new Date(2_000), 999_999); // unknown run: silently ignored

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ status: 'failed', exitReason: 'provider down' });
    t.close();
  });

  test('appendRunActivity batches one row per call, redacts summaries, enforces the cap', () => {
    const t = createTestDb();
    const project = seedProject(t.db, { key: 'INV' });
    const story = seedStory(t.db, project.id, { key: 'INV-7' });
    const run = t.db
      .insert(agentRuns)
      .values({
        storyId: story.id, role: 'implementer', attempt: 1, promptVersion: '1.0',
        opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `act_${story.id}`,
        startedAt: new Date(1_000),
      })
      .returning()
      .get();

    const redact = (s: string) => s.replace(/hunter2/g, '[red]');
    const seq = appendRunActivity(
      t.db, new Date(2_000), run.id,
      [
        { kind: 'tool-start', name: 'bash', summary: 'echo hunter2' },
        { kind: 'tool-start', name: 'Thinking' },
      ],
      redact,
    );
    expect(typeof seq).toBe('number');

    const rows = readOutbox(t.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: 'run.activity', storyId: story.id, provenance: 'system' });
    expect(rows[0]?.data).toEqual({
      runId: run.id, role: 'implementer', storyKey: 'INV-7', projectKey: 'INV',
      events: [{ kind: 'tool-start', name: 'bash', summary: 'echo [red]' }, { kind: 'tool-start', name: 'Thinking' }],
    });

    // Cap: with rowCap=1 the second call is a no-op.
    expect(appendRunActivity(t.db, new Date(3_000), run.id, [{ kind: 'tool-end', name: 'bash' }], redact, 1)).toBeNull();
    expect(readOutbox(t.db)).toHaveLength(1);

    // Unknown run / empty events: no-ops.
    expect(appendRunActivity(t.db, new Date(4_000), 999_999, [{ kind: 'tool-end', name: 'x' }])).toBeNull();
    expect(appendRunActivity(t.db, new Date(5_000), run.id, [])).toBeNull();
    t.close();
  });
});
