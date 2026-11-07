// apps/orchestrator/src/api/routes/office.ts
import { PatchOfficeRoomRequest, type OfficeSnapshot } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OfficeRoomService } from '../../office/room-service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';

const RoomsQuery = z.object({ include: z.literal('archived').optional() });

export function registerOfficeRoutes(
  app: FastifyInstance,
  deps: { db: AikDb; now: Clock; rooms: OfficeRoomService; snapshot?: () => OfficeSnapshot },
): void {
  app.get('/office/rooms', async (req) => deps.rooms.list({ includeArchived: parse(RoomsQuery, req.query).include === 'archived' }));
  mutation(app, deps, 'PATCH', '/office/rooms/:id', async (req) => ({
    status: 200,
    body: deps.rooms.patch(parse(IdParams, req.params).id, parse(PatchOfficeRoomRequest, req.body)),
  }));
  mutation(app, deps, 'POST', '/office/rooms/compact', async () => ({ status: 200, body: deps.rooms.compact() }));
  mutation(app, deps, 'DELETE', '/office/rooms/:id', async (req) => {
    deps.rooms.deleteArchived(parse(IdParams, req.params).id);
    return { status: 200, body: { ok: true } };
  });
  const snapshot = deps.snapshot;
  if (snapshot) app.get('/office/snapshot', async () => snapshot());
}
