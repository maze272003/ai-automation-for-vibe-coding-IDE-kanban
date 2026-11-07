import { defaultProjectSettings } from '@aik/contracts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { EventBus } from '../src/events/bus.ts';
import { WorktreeManager } from '../src/git/worktree.ts';
import { VerificationRunner } from '../src/verify/runner.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { readOutbox } from './helpers/outbox.ts';
import { makeTempDir, makeTempRepo } from './helpers/temp.ts';

describe('verifier check events', () => {
  const t = createTestDb();
  afterAll(() => t.close());

  test('emits check.started/check.finished per check with status', async () => {
    const bus = new EventBus();
    const workflow = new WorkflowService({ db: t.db, bus });
    const worktreeManager = new WorktreeManager({ rootDir: makeTempDir('aikanban-test-vce-wt-') });
    const repoPath = makeTempRepo({ name: 'vce-repo' });
    const project = seedProject(t.db, {
      repoPath,
      baseBranch: 'main',
      settings: {
        ...defaultProjectSettings(),
        checks: [
          { key: 'lint', command: 'node -e "process.exit(0)"', mandatory: true, timeoutSec: 20 },
          { key: 'unit', command: 'node -e "process.exit(1)"', mandatory: true, timeoutSec: 20 },
        ],
      },
    });
    const { worktreePath } = await worktreeManager.ensureStoryWorktree({ repoPath, storyKey: 'VCE-1', baseBranch: 'main' });
    fs.writeFileSync(path.join(worktreePath, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'feat: f'], { cwd: worktreePath });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    const story = seedStory(t.db, project.id, { key: 'VCE-1', status: 'TESTING', candidateSha, candidateTree });

    const verifier = new VerificationRunner({ db: t.db, workflow, bus, worktreeManager, logsDir: makeTempDir('aikanban-logs-') });
    await verifier.verifyStory(story.id);

    const events = readOutbox(t.db).filter((e) => e.topic.startsWith('check.'));
    const pairs = events.map((e) => [e.topic, (e.data as { checkKey: string }).checkKey]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['check.started', 'lint'], ['check.finished', 'lint'],
        ['check.started', 'unit'], ['check.finished', 'unit'],
        ['check.started', 'secrets'], ['check.finished', 'secrets'],
      ]),
    );
    const fin = events.find((e) => e.topic === 'check.finished' && (e.data as { checkKey: string }).checkKey === 'unit');
    expect(fin?.data).toMatchObject({ status: 'failed', mandatory: true, projectKey: project.key, storyKey: 'VCE-1', storyId: story.id });
    expect((fin?.data as { durationMs: unknown }).durationMs).toEqual(expect.any(Number));
    const secretsFin = events.find((e) => e.topic === 'check.finished' && (e.data as { checkKey: string }).checkKey === 'secrets');
    expect(secretsFin?.data).toMatchObject({ status: 'passed', mandatory: true, durationMs: expect.any(Number) });
    expect(fin?.provenance).toBe('command_completed');
    // Balance: every started has a later finished, and the last event per key is a finish.
    const keys = new Set(events.map((e) => (e.data as { checkKey: string }).checkKey));
    for (const key of keys) {
      const ev = events.filter((e) => (e.data as { checkKey: string }).checkKey === key);
      const started = ev.filter((e) => e.topic === 'check.started');
      const finished = ev.filter((e) => e.topic === 'check.finished');
      expect(started.length).toBe(finished.length);
      expect(ev[ev.length - 1]!.topic).toBe('check.finished');
    }
    for (const key of ['lint', 'unit', 'secrets']) {
      const s = events.find((e) => e.topic === 'check.started' && (e.data as { checkKey: string }).checkKey === key)!;
      const f = events.find((e) => e.topic === 'check.finished' && (e.data as { checkKey: string }).checkKey === key)!;
      expect(s.seq).toBeLessThan(f.seq);
      expect(s.provenance).toBe('system');
    }
  }, 60_000);
});
