// apps/orchestrator/test/helpers/app.ts
import crypto from 'node:crypto';
import { createApiServer } from '../../src/api/server.ts';
import { registerProjectRoutes } from '../../src/api/routes/projects.ts';
import { registerStoryRoutes } from '../../src/api/routes/stories.ts';
import { EventBus } from '../../src/events/bus.ts';
import { ProjectService } from '../../src/projects/service.ts';
import { createRedactor } from '../../src/secrets/redactor.ts';
import { StoryService } from '../../src/stories/service.ts';
import { WorkflowService } from '../../src/workflow/service.ts';
import { createTestDb } from './db.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41236;

export async function buildTestApp() {
  const t = createTestDb();
  const now = () => 1_700_000_000_000;
  const bus = new EventBus();
  const workflow = new WorkflowService({ db: t.db, bus, now, redact: createRedactor().redact });
  const projects = new ProjectService({ db: t.db, now });
  const stories = new StoryService({ db: t.db, workflow, bus, now });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProjectRoutes(app, { db: t.db, now, projects });
  registerStoryRoutes(app, { db: t.db, now, stories });
  await app.ready();
  const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, key: string = crypto.randomUUID()) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    });
  return { t, app, inject, bus, services: { workflow, projects, stories } };
}
