// apps/orchestrator/src/api/routes/providers.ts
// Root-relative paths (/providers, not /api/providers), matching the other route modules.
// `db` is optional because ProviderService owns the connection — the routes only need it to
// satisfy the idempotency helper, and the regular app wiring may pass it explicitly.
import { ConnectProviderSchema, SetDefaultModelSchema } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProviderService } from '../../providers/service.ts';
import type { Clock } from '../../time.ts';
import { ApiHttpError } from '../errors.ts';
import { mutation, parse } from '../idempotency.ts';

const IdParam = z.object({ id: z.string().min(1).max(120) });

export function registerProviderRoutes(
  app: FastifyInstance,
  deps: { db?: AikDb; now: Clock; providers: ProviderService },
): void {
  const mutationDeps = { db: deps.db ?? deps.providers.db, now: deps.now };

  // The full catalog with connection state. Never carries key material — the DTO shape is key-free by contract.
  app.get('/providers', async () => ({ providers: deps.providers.list() }));

  mutation(app, mutationDeps, 'POST', '/providers', async (req) => {
    const body = parse(ConnectProviderSchema, req.body);
    try {
      const provider = await deps.providers.connect(body);
      return { status: 200, body: { ok: true, provider } };
    } catch (err) {
      // `PROVIDER_REJECTED` is not a valid ErrorCode in @aik/contracts, so 400s reuse the
      // repo-wide VALIDATION_FAILED code with the service's own message.
      throw new ApiHttpError(400, 'VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  mutation(app, mutationDeps, 'DELETE', '/providers/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    deps.providers.remove(id);
    return { status: 200, body: { ok: true } };
  });

  app.get('/settings/default-model', async () => deps.providers.getDefaultModel() ?? { providerId: null, modelId: null });

  mutation(app, mutationDeps, 'PUT', '/settings/default-model', async (req) => {
    const body = parse(SetDefaultModelSchema, req.body);
    try {
      deps.providers.setDefaultModel(body);
    } catch (err) {
      throw new ApiHttpError(400, 'VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
    }
    return { status: 200, body: { ok: true } };
  });
}
