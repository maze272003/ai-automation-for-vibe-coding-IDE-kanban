// apps/orchestrator/test/sse.test.ts
import { createSseParser, type EventEnvelope } from '@aik/contracts';
import { outboxEvents } from '@aik/db';
import { lte } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerEventRoutes } from '../src/api/routes/events.ts';
import { createApiServer } from '../src/api/server.ts';
import { EventBus } from '../src/events/bus.ts';
import { appendOutbox } from '../src/events/outbox.ts';
import { createTestDb } from './helpers/db.ts';

const TOKEN = 't'.repeat(43);
let t: ReturnType<typeof createTestDb>;
let bus: EventBus;
let app: ReturnType<typeof createApiServer>;
let port = 0;

beforeEach(async () => {
  t = createTestDb();
  bus = new EventBus();
  app = createApiServer({ token: TOKEN, getPort: () => port });
  registerEventRoutes(app, { db: t.db, bus, heartbeatMs: 50 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(async () => {
  await app.close();
  t.close();
});

function emit(n: number): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) seqs.push(appendOutbox(t.db, { topic: 'story.updated', storyId: null, provenance: 'system', data: { i } }, new Date()));
  bus.notify(seqs.at(-1)!);
  return seqs;
}

async function connect(lastEventId?: number) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}) },
    signal: controller.signal,
  });
  const received: EventEnvelope[] = [];
  let raw = '';
  const parse = createSseParser((m) => received.push(JSON.parse(m.data) as EventEnvelope));
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        parse(text);
      }
    } catch {
      /* aborted */
    }
  })();
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for events');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { res, received, raw: () => raw, waitFor, close: () => controller.abort() };
}

describe('GET /events', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(401);
  });

  it('streams live events after connecting', async () => {
    const c = await connect();
    expect(c.res.headers.get('content-type')).toContain('text/event-stream');
    const [seq] = emit(1);
    await c.waitFor(() => c.received.length === 1);
    expect(c.received[0]).toMatchObject({ seq, topic: 'story.updated', provenance: 'system', data: { i: 0 } });
    c.close();
  });

  it('replays events after Last-Event-ID in order, without duplicates on later notifications', async () => {
    const seqs = emit(3);
    const c = await connect(seqs[0]);
    await c.waitFor(() => c.received.length === 2);
    bus.notify(seqs[2]!); // nothing new: must not resend
    await new Promise((r) => setTimeout(r, 100));
    expect(c.received.map((e) => e.seq)).toEqual([seqs[1], seqs[2]]);
    c.close();
  });

  it('replays more than one batch in order', async () => {
    const seqs = emit(1200);
    const c = await connect(0);
    await c.waitFor(() => c.received.length === 1200, 10_000);
    expect(c.received.map((e) => e.seq)).toEqual(seqs);
    c.close();
  });

  it('sends system.resync when the requested position was pruned', async () => {
    const seqs = emit(5);
    t.db.delete(outboxEvents).where(lte(outboxEvents.seq, seqs[2]!)).run();
    const c = await connect(seqs[0]);
    await c.waitFor(() => c.received.length >= 1);
    expect(c.received[0]?.topic).toBe('system.resync');
    c.close();
  });

  it('sends heartbeat comments', async () => {
    const c = await connect();
    await c.waitFor(() => c.raw().includes(': hb'));
    c.close();
  });
});
