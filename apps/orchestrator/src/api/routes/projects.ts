// apps/orchestrator/src/api/routes/projects.ts
import { CreateProjectRequest, PatchProjectRequest } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectService } from '../../projects/service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

export function registerProjectRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; projects: ProjectService }): void {
  app.get('/projects', async () => deps.projects.list());
  app.get('/projects/:id', async (req) => deps.projects.get(parse(IdParams, req.params).id));
  mutation(app, deps, 'POST', '/projects', async (req) => ({ status: 201, body: await deps.projects.create(parse(CreateProjectRequest, req.body)) }));
  mutation(app, deps, 'PATCH', '/projects/:id', async (req) => ({
    status: 200,
    body: deps.projects.patch(parse(IdParams, req.params).id, parse(PatchProjectRequest, req.body)),
  }));
}
