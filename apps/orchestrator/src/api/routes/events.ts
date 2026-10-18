// apps/orchestrator/src/api/routes/events.ts
import { formatSse, type EventEnvelope } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../../events/bus.ts';
import { outboxBounds, readOutboxAfter } from '../../events/outbox.ts';
import { systemClock, type Clock } from '../../time.ts';

const BATCH = 500;

export function registerEventRoutes(app: FastifyInstance, deps: { db: AikDb; bus: EventBus; heartbeatMs?: number; now?: Clock }): void {
  const now = deps.now ?? systemClock;
  app.get('/events', (req, reply) => {
    const header = req.headers['last-event-id'];
    const requested = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : null;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.flushHeaders();

    const bounds = outboxBounds(deps.db);
    let lastSent = requested ?? bounds.max ?? 0;
    if (requested !== null && bounds.min !== null && requested < bounds.min - 1) {
      const resync: EventEnvelope = { seq: bounds.max ?? requested, topic: 'system.resync', storyId: null, at: now(), provenance: 'system', data: { reason: 'replay window exceeded' } };
      res.write(formatSse({ id: resync.seq, data: JSON.stringify(resync) }));
      lastSent = resync.seq;
    }

    const flush = () => {
      for (;;) {
        const batch = readOutboxAfter(deps.db, lastSent, BATCH);
        for (const ev of batch) {
          res.write(formatSse({ id: ev.seq, data: JSON.stringify(ev) }));
          lastSent = ev.seq;
        }
        if (batch.length < BATCH) break;
      }
    };
    flush();
    const unsubscribe = deps.bus.subscribe(flush);
    const heartbeat = setInterval(() => res.write(': hb\n\n'), deps.heartbeatMs ?? 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
