// apps/orchestrator/src/api/routes/git-view.ts
import {
  GitBranchCheckoutRequest, GitBranchCreateRequest, GitCommitRequest, GitDiscardRequest, GitStageRequest,
} from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { GitViewService } from '../../git/view-service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';
import { z } from 'zod';

export function registerGitViewRoutes(app: FastifyInstance, deps: { db: AikDb; now: Clock; gitView: GitViewService }): void {
  const idOf = (req: { params: unknown }) => parse(IdParams, req.params).id;
  const ShaParams = z.object({ id: z.coerce.number().int().positive(), sha: z.string().regex(/^[0-9a-f]{40}$/) });

  app.get('/projects/:id/git/status', async (req) => deps.gitView.status(idOf(req)));
  app.get('/projects/:id/git/log', async (req) => {
    const q = req.query as { limit?: string };
    return deps.gitView.log(idOf(req), q.limit ? Number(q.limit) : 50);
  });
  app.get('/projects/:id/git/commits/:sha/files', async (req) => {
    const p = parse(ShaParams, req.params);
    return deps.gitView.commitFiles(p.id, p.sha);
  });
  app.get('/projects/:id/git/branches', async (req) => deps.gitView.branches(idOf(req)));

  mutation(app, deps, 'POST', '/projects/:id/git/stage', async (req) => ({ status: 200, body: await deps.gitView.stage(idOf(req), parse(GitStageRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/unstage', async (req) => ({ status: 200, body: await deps.gitView.unstage(idOf(req), parse(GitStageRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/commit', async (req) => ({ status: 200, body: await deps.gitView.commit(idOf(req), parse(GitCommitRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/discard', async (req) => ({ status: 200, body: await deps.gitView.discard(idOf(req), parse(GitDiscardRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/push', async (req) => ({ status: 200, body: await deps.gitView.push(idOf(req)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/pull', async (req) => ({ status: 200, body: await deps.gitView.pull(idOf(req)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/branches/checkout', async (req) => ({ status: 200, body: await deps.gitView.checkout(idOf(req), parse(GitBranchCheckoutRequest, req.body)) }));
  mutation(app, deps, 'POST', '/projects/:id/git/branches/create', async (req) => ({ status: 200, body: await deps.gitView.createBranch(idOf(req), parse(GitBranchCreateRequest, req.body)) }));
}
