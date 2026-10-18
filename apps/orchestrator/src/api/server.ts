// apps/orchestrator/src/api/server.ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { installErrorHandling } from './errors.ts';
import { securityHook } from './security.ts';

export function createApiServer(opts: { token: string; getPort: () => number; logger?: Logger }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, forceCloseConnections: true, return503OnClosing: true });
  app.addHook('onRequest', securityHook({ token: opts.token, getPort: opts.getPort }));
  installErrorHandling(app, (err) => opts.logger?.error({ err }, 'request failed'));
  return app;
}
