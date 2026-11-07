// apps/orchestrator/test/helpers/app.ts
import crypto from 'node:crypto';
import { createApiServer } from '../../src/api/server.ts';
import { registerFileRoutes } from '../../src/api/routes/files.ts';
import { registerGitViewRoutes } from '../../src/api/routes/git-view.ts';
import { registerProjectRoutes } from '../../src/api/routes/projects.ts';
import { registerStoryRoutes } from '../../src/api/routes/stories.ts';
import { WorkspaceFileService } from '../../src/files/service.ts';
import { GitViewService } from '../../src/git/view-service.ts';
import { WorktreeManager } from '../../src/git/worktree.ts';
import { EventBus } from '../../src/events/bus.ts';
import { registerOfficeRoutes } from '../../src/api/routes/office.ts';
import { OfficeRoomService } from '../../src/office/room-service.ts';
import { buildOfficeSnapshot } from '../../src/office/snapshot.ts';
import { projectBusyReason } from '../../src/projects/busy.ts';
import { ProjectService } from '../../src/projects/service.ts';
import { createRedactor } from '../../src/secrets/redactor.ts';
import { StoryService } from '../../src/stories/service.ts';
import { WorkflowService } from '../../src/workflow/service.ts';
import { createTestDb } from './db.ts';
import { makeTempDir } from './temp.ts';

import type { LocalMerger } from '../../src/git/merger.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41236;

export async function buildTestApp(
  options?: { merger?: LocalMerger; fakeBusy?: (projectId: number) => string | null; worktrees?: string; beforeStart?: (db: ReturnType<typeof createTestDb>['db']) => void },
) {
  const t = createTestDb();
  const now = () => 1_700_000_000_000;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db: t.db, bus, now, redact: createRedactor().redact });
  const worktrees = options?.worktrees ?? makeTempDir('aikanban-test-wt-');
  const purgeLines: string[] = [];
  const worktreeManager = new WorktreeManager({ rootDir: worktrees, db: t.db, now });
  const rooms = new OfficeRoomService({ db: t.db, bus, now });
  const projects = new ProjectService({
    db: t.db,
    rooms,
    now,
    worktreePurge: (input) => worktreeManager.purgeForProject(input),
    purgeLog: (line) => purgeLines.push(line),
  });
  // Mirrors app.ts startup: seed hook stands in for pre-existing rows, then reconcile.
  options?.beforeStart?.(t.db);
  rooms.reconcile();
  const stories = new StoryService({ db: t.db, workflow, bus, now, merger: options?.merger });
  const busy = options?.fakeBusy ?? ((projectId: number) => projectBusyReason(t.db, projectId));
  const gitView = new GitViewService({ db: t.db, projects, busy });
  const files = new WorkspaceFileService({ projects, busy });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now, projects });
  registerOfficeRoutes(app, { db: t.db, now, rooms, snapshot: () => buildOfficeSnapshot(t.db, now) });
  registerGitViewRoutes(app, { db: t.db, now, gitView });
  registerFileRoutes(app, { db: t.db, now, files });
  registerStoryRoutes(app, { db: t.db, now, stories });
  await app.ready();
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, key: string = crypto.randomUUID()) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    });
  return { t, app, inject, bus, purgeLines, worktrees, services: { rooms, workflow, projects, stories, gitView, files } };
}
