// apps/orchestrator/src/api/idempotency.ts
import { apiIdempotency, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../time.ts';
import { ApiHttpError } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiHttpError(400, 'VALIDATION_FAILED', z.prettifyError(r.error), { details: r.error.issues });
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Result = { status: number; body: unknown };

export function mutation(
  app: FastifyInstance,
  deps: { db: AikDb; now: Clock },
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  handler: (req: FastifyRequest) => Promise<Result>,
): void {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !UUID.test(key)) {
        throw new ApiHttpError(400, 'VALIDATION_FAILED', 'An Idempotency-Key header (UUID) is required for this request');
      }
      const route = `${method} ${url}`;
      const requestHash = crypto.createHash('sha256').update(`${route}\n${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
      const existing = deps.db.select().from(apiIdempotency).where(eq(apiIdempotency.key, key)).get();
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiHttpError(422, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request');
        }
        return reply.status(existing.responseStatus).send(existing.responseBody ?? undefined);
      }
      const result = await handler(req);
      deps.db
        .insert(apiIdempotency)
        .values({ key, route, requestHash, responseStatus: result.status, responseBody: result.body ?? null, createdAt: new Date(deps.now()) })
        .onConflictDoNothing()
        .run();
      return reply.status(result.status).send(result.body ?? undefined);
    },
  });
}
