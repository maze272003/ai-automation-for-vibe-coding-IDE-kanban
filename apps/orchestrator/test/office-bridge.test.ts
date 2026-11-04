// apps/orchestrator/test/office-bridge.test.ts
import { describe, expect, test } from 'vitest';
import { appendOutbox } from '../src/events/outbox.ts';
import { EventBus } from '../src/events/bus.ts';
import {
  hookEventsForRunFinished,
  hookEventsForRunStarted,
  PixelAgentsBridge,
  type HookEvent,
} from '../src/office/bridge.ts';
import { createTestDb } from './helpers/db.ts';
import { outboxBounds } from '../src/events/outbox.ts';

const RUN_STARTED = { runId: 7, role: 'implementer', storyKey: 'INV-4', projectKey: 'INV' };
const RUN_FINISHED = { ...RUN_STARTED, status: 'succeeded' };

/** Records POSTs; can be scripted to fail N times with a 500 before succeeding. */
function makeFetch(script: Array<{ status: number } | { error: string }>) {
  const posts: Array<{ url: string; auth?: string; body: HookEvent }> = [];
  const healthCalls: string[] = [];
  let call = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u.endsWith('/api/health')) {
      healthCalls.push(u);
      const step = script[call];
      call += 1;
      if (step && 'error' in step) throw new Error(step.error);
      return new Response('ok', { status: step?.status ?? 200 });
    }
    posts.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) as HookEvent });
    const step = script[call];
    call += 1;
    if (step && 'error' in step) throw new Error(step.error);
    return new Response('ok', { status: step?.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, posts, healthCalls };
}

/** Minimal WebSocket double: auto-opens on the next tick, records sent frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {}
}

function makeBridge(overrides: Partial<ConstructorParameters<typeof PixelAgentsBridge>[0]> = {}) {
  const t = createTestDb();
  const bus = new EventBus();
  const warns: Array<Record<string, unknown> | string> = [];
  const bridge = new PixelAgentsBridge({
    db: t.db,
    bus,
    logger: {
      info: () => undefined,
      warn: (obj, msg) => warns.push({ ...obj, msg }),
    },
    redact: (text) => text.replaceAll('sekret-token', '[REDACTED:secret]'),
    office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
    healthIntervalMs: 60_000,
    retryDelaysMs: [0, 0],
    ...overrides,
  });
  return { t, bus, warns, bridge };
}

describe('hook event translation (pure)', () => {
  test('started spawns a character: SessionStart(cwd label) + confirming PreToolUse', () => {
    expect(hookEventsForRunStarted(RUN_STARTED)).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'SessionStart', source: 'startup', cwd: 'AIK/INV/INV-4 implementer' },
      { session_id: 'aik-run-7', hook_event_name: 'PreToolUse', tool_name: 'aik-implementer', tool_input: { story: 'INV-4' } },
    ]);
  });

  test('finished despawns: PostToolUse + Stop + SessionEnd', () => {
    expect(hookEventsForRunFinished(RUN_FINISHED)).toEqual([
      { session_id: 'aik-run-7', hook_event_name: 'PostToolUse', tool_name: 'aik-implementer', tool_input: { story: 'INV-4' } },
      { session_id: 'aik-run-7', hook_event_name: 'Stop' },
      { session_id: 'aik-run-7', hook_event_name: 'SessionEnd', reason: 'exit' },
    ]);
  });

  test('garbage payloads translate to nothing', () => {
    expect(hookEventsForRunStarted(null)).toEqual([]);
    expect(hookEventsForRunStarted({ runId: 'x' })).toEqual([]);
    expect(hookEventsForRunFinished('nope')).toEqual([]);
  });
});

describe('PixelAgentsBridge', () => {
  test('healthy path: pushes watchAllSessions once, posts events with Bearer auth', async () => {
    const t = createTestDb();
    const bus = new EventBus();
    FakeWebSocket.instances = [];
    const { impl, posts, healthCalls } = makeFetch([]);
    const bridge = new PixelAgentsBridge({
      db: t.db, bus, logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    bridge.start();
    await bridge.poll(); // immediate health + settings push + drain

    expect(healthCalls[0]).toBe('http://127.0.0.1:45999/api/health');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:45999/ws?token=sekret-token');
    expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"webviewReady"}');
    expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"setWatchAllSessions","enabled":true}');

    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    bus.notify(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(posts.map((p) => p.url)).toEqual(['http://127.0.0.1:45999/api/hooks/aik', 'http://127.0.0.1:45999/api/hooks/aik']);
    expect(posts[0]?.auth).toBe('Bearer sekret-token');
    expect(posts[0]?.body.hook_event_name).toBe('SessionStart');
    expect(posts[1]?.body.hook_event_name).toBe('PreToolUse');
    bridge.stop();
    t.close();
  });

  test('unhealthy path: queues, then flushes in order once health recovers', async () => {
    const t = createTestDb();
    const bus = new EventBus();
    FakeWebSocket.instances = [];
    const posts: string[] = [];
    let down = true;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.endsWith('/api/health')) {
        if (down) throw new Error('down');
        return new Response('ok', { status: 200 });
      }
      if (down) throw new Error('down');
      posts.push((JSON.parse(String(init?.body)) as HookEvent).hook_event_name);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = new PixelAgentsBridge({
      db: t.db, bus, logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, webSocketImpl: FakeWebSocket as unknown as new (url: string) => WebSocket,
      healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    bridge.start();
    await bridge.poll(); // health fails → not healthy

    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    appendOutbox(t.db, { topic: 'run.finished', storyId: 1, provenance: 'system', data: RUN_FINISHED }, new Date());
    bus.notify(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]); // queued, not posted

    down = false;
    await bridge.poll(); // health recovers → flush the queue in FIFO order
    expect(posts).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
    bridge.stop();
    t.close();
  });

  test('queue is bounded and drops oldest', async () => {
    // fetchImpl override: with the default global fetch, this bridge's initial health check
    // resolves on real socket I/O only after t.close() below, leaving an unhandled rejection.
    const { t, bridge } = makeBridge({ queueCap: 2, fetchImpl: makeFetch([{ error: 'down' }]).impl });
    expect((bridge as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    bridge.start();
    const health = makeFetch([{ error: 'down' }, { error: 'down' }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: health.impl, healthIntervalMs: 60_000, queueCap: 2, retryDelaysMs: [0, 0],
    });
    b2.start();
    await b2.poll(); // unhealthy
    const internals = b2 as unknown as { enqueue: (e: HookEvent) => void; queue: HookEvent[] };
    for (const name of ['a', 'b', 'c', 'd']) internals.enqueue({ session_id: name, hook_event_name: 'Stop' });
    expect(internals.queue.map((e) => e.session_id)).toEqual(['c', 'd']);
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('retries a 500 twice then succeeds; a 4xx is dropped without retry', async () => {
    const { impl, posts } = makeFetch([{ status: 500 }, { status: 500 }]);
    const t = createTestDb();
    const bridge = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    const post = (bridge as unknown as { post: (e: HookEvent) => Promise<void> }).post.bind(bridge);
    await post({ session_id: 's1', hook_event_name: 'Stop' }); // 500, 500, then 200
    expect(posts).toHaveLength(3);
    const drop = makeFetch([{ status: 400 }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: drop.impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    await (b2 as unknown as { post: (e: HookEvent) => Promise<void> }).post({ session_id: 's2', hook_event_name: 'Stop' });
    expect(drop.posts).toHaveLength(1); // no retry on 4xx
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('token is redacted in warn logs', async () => {
    const { t, bridge, warns } = makeBridge();
    const { impl } = makeFetch([{ error: 'conn refused sekret-token' }, { error: 'conn refused sekret-token' }, { error: 'conn refused sekret-token' }]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(),
      logger: { info: () => undefined, warn: (obj, msg) => warns.push({ ...obj, msg }) },
      redact: (text) => text.replaceAll('sekret-token', '[REDACTED:secret]'),
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    // post() rejects once its retries are exhausted — the redacted warn it logs first is the point here.
    await (b2 as unknown as { post: (e: HookEvent) => Promise<void> })
      .post({ session_id: 's', hook_event_name: 'Stop' })
      .catch(() => undefined);
    const flat = JSON.stringify(warns);
    expect(flat).not.toContain('sekret-token');
    expect(flat).toContain('[REDACTED:secret]');
    bridge.stop();
    b2.stop();
    t.close();
  });

  test('cursor starts at outbox max: a restarted bridge never replays old runs', async () => {
    const { t, bridge } = makeBridge();
    appendOutbox(t.db, { topic: 'run.started', storyId: 1, provenance: 'system', data: RUN_STARTED }, new Date());
    const before = outboxBounds(t.db).max;
    const { impl, posts } = makeFetch([]);
    const b2 = new PixelAgentsBridge({
      db: t.db, bus: new EventBus(), logger: { info: () => undefined, warn: () => undefined }, redact: (s) => s,
      office: { url: 'http://127.0.0.1:45999', token: 'sekret-token' },
      fetchImpl: impl, healthIntervalMs: 60_000, retryDelaysMs: [0, 0],
    });
    b2.start();
    await b2.poll();
    expect(posts.filter((p) => p.url.includes('/api/hooks/'))).toHaveLength(0); // old row skipped
    expect(before).toBeGreaterThan(0);
    bridge.stop();
    b2.stop();
    t.close();
  });
});
