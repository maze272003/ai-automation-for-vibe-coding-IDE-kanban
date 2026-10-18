// apps/orchestrator/src/api/routes/stories.ts
import { CreateStoryRequest, PatchStoryRequest, StoryListQuery, TransitionRequest } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { StoryService } from '../../stories/service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';

export function registerStoryRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; stories: StoryService }): void {
  app.get('/projects/:id/stories', async (req) => deps.stories.list(parse(IdParams, req.params).id, parse(StoryListQuery, req.query)));
  app.get('/stories/:id', async (req) => deps.stories.get(parse(IdParams, req.params).id));
  mutation(app, deps, 'POST', '/projects/:id/stories', async (req) => ({
    status: 201,
    body: deps.stories.create(parse(IdParams, req.params).id, parse(CreateStoryRequest, req.body)),
  }));
  mutation(app, deps, 'PATCH', '/stories/:id', async (req) => ({
    status: 200,
    body: deps.stories.patch(parse(IdParams, req.params).id, parse(PatchStoryRequest, req.body)),
  }));
  mutation(app, deps, 'POST', '/stories/:id/transitions', async (req) => ({
    status: 200,
    body: deps.stories.transition(parse(IdParams, req.params).id, parse(TransitionRequest, req.body), req.headers['idempotency-key'] as string),
  }));
}
