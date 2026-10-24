// apps/orchestrator/test/busy.test.ts
import { agentRuns, merges, verificationRuns } from '@aik/db';
import { describe, expect, it } from 'vitest';
import { projectBusyReason } from '../src/projects/busy.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

const NOW = new Date(1_700_000_000_000);

describe('projectBusyReason', () => {
  it('is null on a silent project', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    expect(projectBusyReason(t.db, p.id)).toBeNull();
  });

  it('names the story with a running agent run', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id, { key: 'P1A-4' });
    t.db.insert(agentRuns).values({
      storyId: s.id, role: 'implementer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0',
      idempotencyKey: 'k-run-1', status: 'running', startedAt: NOW,
    }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('P1A-4');
  });

  it('sees queued runs, running verifications and merges', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(verificationRuns).values({ storyId: s.id, commitSha: 'a'.repeat(40), trigger: 'candidate', status: 'running', startedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('verification');
    t.db.insert(agentRuns).values({ storyId: s.id, role: 'reviewer', attempt: 1, promptVersion: 'v1', opencodeVersion: '0', idempotencyKey: 'k-run-2', status: 'queued' }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('queued');
    t.db.insert(merges).values({ storyId: s.id, method: 'local_merge', approvedSha: 'a'.repeat(40), status: 'running', startedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toContain('merging');
  });

  it('ignores finished work', () => {
    const t = createTestDb();
    const p = seedProject(t.db);
    const s = seedStory(t.db, p.id);
    t.db.insert(agentRuns).values({ storyId: s.id, role: 'planner', attempt: 1, promptVersion: 'v1', opencodeVersion: '0', idempotencyKey: 'k-run-3', status: 'succeeded', startedAt: NOW, endedAt: NOW }).run();
    expect(projectBusyReason(t.db, p.id)).toBeNull();
  });
});
