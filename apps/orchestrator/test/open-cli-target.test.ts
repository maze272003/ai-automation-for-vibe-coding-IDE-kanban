// apps/orchestrator/test/open-cli-target.test.ts — GET /stories/:id/open-cli-target (spec
// §6.3, §5.11; plan 6.1a-13): the desktop's no-shell launch resolves the session ref and
// worktree here, server-side, so the renderer never supplies them.
import { agentRuns, workspaces } from '@aik/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.ts';
import { EventBus } from '../src/events/bus.ts';
import { registerStoryRoutes } from '../src/api/routes/stories.ts';
import { StoryService } from '../src/stories/service.ts';
import { WorkflowService } from '../src/workflow/service.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir } from './helpers/temp.ts';

const TOKEN = 'o'.repeat(43);
const PORT = 41299;

let t: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiServer>;

beforeEach(async () => {
  t = createTestDb();
  const bus = new EventBus();
  const workflow = new WorkflowService({ db: t.db, bus });
  const stories = new StoryService({ db: t.db, workflow, bus });
  app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerStoryRoutes(app, { db: t.db, now: () => 1, stories });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

const auth = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };
const get = (id: number | string, headers: Record<string, string> = auth) =>
  app.inject({ method: 'GET', url: `/stories/${id}/open-cli-target`, headers });

let seq = 0;

const seedStoryRow = () => {
  seq += 1;
  const project = seedProject(t.db, { key: `OC${seq}`, name: `Open CLI ${seq}` });
  return seedStory(t.db, project.id, { key: `OC${seq}-1` });
};

const seedRun = (storyId: number, sessionRef: string | null, idempotencyKey: string) =>
  t.db
    .insert(agentRuns)
    .values({
      storyId,
      role: 'planner',
      attempt: 1,
      promptVersion: '1.0',
      opencodeVersion: '2.0.32',
      status: 'succeeded',
      opencodeSessionId: sessionRef,
      idempotencyKey,
      startedAt: new Date(),
      endedAt: new Date(),
    })
    .returning()
    .get();

const seedWorktree = (storyId: number, cwd: string, overrides: Partial<typeof workspaces.$inferInsert> = {}) =>
  t.db
    .insert(workspaces)
    .values({ storyId, kind: 'story', path: cwd, status: 'active', createdAt: new Date(), ...overrides })
    .returning()
    .get();

describe('GET /stories/:id/open-cli-target', () => {
  it('requires authentication', async () => {
    const story = seedStoryRow();
    const missing = await get(story.id, { host: auth.host });
    const wrong = await get(story.id, { ...auth, authorization: `Bearer ${'p'.repeat(43)}` });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toEqual('UNAUTHORIZED');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toEqual('UNAUTHORIZED');
  });

  it('returns the story worktree and the latest OpenCode session ref', async () => {
    const story = seedStoryRow();
    const worktree = makeTempDir('aik-open-cli-wt-');
    seedRun(story.id, 'ses_old1', 'run_1');
    seedRun(story.id, 'ses_new2', 'run_2');
    seedWorktree(story.id, worktree);

    const r = await get(story.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ runtime: 'opencode', sessionRef: 'ses_new2', cwd: worktree });
  });

  it('is unavailable for a story whose runs have no OpenCode session', async () => {
    const story = seedStoryRow();
    seedWorktree(story.id, makeTempDir('aik-open-cli-wt-'));
    seedRun(story.id, null, 'run_1');
    seedRun(story.id, null, 'run_2');

    const r = await get(story.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ available: false, reason: 'No OpenCode session for this story' });
  });

  it('is unavailable when the story has no usable worktree row', async () => {
    const noRow = seedStoryRow();
    seedRun(noRow.id, 'ses_new2', 'run_1');
    expect((await get(noRow.id)).json()).toEqual({ available: false, reason: 'No story worktree' });

    const removed = seedStoryRow();
    seedRun(removed.id, 'ses_new2', 'run_2');
    seedWorktree(removed.id, makeTempDir('aik-open-cli-wt-'), { status: 'removed', removedAt: new Date() });
    expect((await get(removed.id)).json()).toEqual({ available: false, reason: 'No story worktree' });

    const wrongKind = seedStoryRow();
    seedRun(wrongKind.id, 'ses_new2', 'run_3');
    seedWorktree(wrongKind.id, makeTempDir('aik-open-cli-wt-'), { kind: 'review' });
    expect((await get(wrongKind.id)).json()).toEqual({ available: false, reason: 'No story worktree' });
  });

  it('404s for an unknown story', async () => {
    const r = await get(999_123);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toEqual('NOT_FOUND');
  });
});
