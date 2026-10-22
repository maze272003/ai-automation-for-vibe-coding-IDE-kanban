import {
  CloneRepositoryRequestSchema,
  LinkRepositoryRequestSchema,
  PatchGitHubSettingsSchema,
} from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GitHubCloneService } from '../../github/clone-service.ts';
import type { GitHubMergeService } from '../../github/merge-service.ts';
import type { GitHubPRPoller } from '../../github/pr-poller.ts';
import type { GitHubPublishService } from '../../github/publish-service.ts';
import type { GitHubRepositoryService } from '../../github/repository-service.ts';
import type { GitHubAuthService } from '../../github/service.ts';
import type { GitHubSyncService } from '../../github/sync-service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';

const PollParams = z.object({
  sessionToken: z.string().min(1),
});

const IdParam = z.object({
  id: z.coerce.number().int().positive(),
});

export function registerGitHubRoutes(
  app: FastifyInstance,
  deps: {
    db: AikDb;
    now: Clock;
    github: GitHubAuthService;
    githubRepos?: GitHubRepositoryService;
    githubClone?: GitHubCloneService;
    githubSync?: GitHubSyncService;
    githubPublish?: GitHubPublishService;
    githubPoller?: GitHubPRPoller;
    githubMerge?: GitHubMergeService;
  },
): void {
  app.get('/github/settings', async () => deps.github.getSettings());
  app.get('/github/connection', async () => deps.github.getConnection());

  mutation(app, deps, 'PATCH', '/github/settings', async (req) => {
    const body = parse(PatchGitHubSettingsSchema, req.body);
    return {
      status: 200,
      body: await deps.github.setClientId(body.clientId),
    };
  });

  mutation(app, deps, 'POST', '/github/connection/device-start', async () => {
    return {
      status: 200,
      body: await deps.github.startDeviceFlow(),
    };
  });

  mutation(app, deps, 'POST', '/github/connection/device-poll', async (req) => {
    const body = parse(PollParams, req.body);
    return {
      status: 200,
      body: await deps.github.pollDeviceFlow(body.sessionToken),
    };
  });

  mutation(app, deps, 'POST', '/github/connection/disconnect', async () => {
    await deps.github.disconnect();
    return {
      status: 200,
      body: { ok: true },
    };
  });

  mutation(app, deps, 'POST', '/github/connection/refresh', async () => {
    const refreshed = await deps.github.refreshToken();
    return {
      status: 200,
      body: { refreshed },
    };
  });

  if (deps.githubRepos) {
    app.get('/github/repositories', async () => deps.githubRepos!.listRepositories());

    mutation(app, deps, 'POST', '/github/repositories/refresh', async () => ({
      status: 200,
      body: await deps.githubRepos!.listRepositories({ forceRefresh: true }),
    }));
  }

  if (deps.githubClone) {
    mutation(app, deps, 'POST', '/github/repositories/:id/clone', async (req) => {
      const { id } = parse(IdParam, req.params);
      const body = parse(CloneRepositoryRequestSchema, req.body);
      return {
        status: 200,
        body: await deps.githubClone!.cloneRepository(id, body),
      };
    });

    mutation(app, deps, 'POST', '/github/repositories/:id/link', async (req) => {
      const { id } = parse(IdParam, req.params);
      const body = parse(LinkRepositoryRequestSchema, req.body);
      return {
        status: 200,
        body: await deps.githubClone!.linkRepository(id, body),
      };
    });
  }
}

