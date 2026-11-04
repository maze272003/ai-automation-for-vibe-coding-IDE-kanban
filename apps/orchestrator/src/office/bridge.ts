// apps/orchestrator/src/office/bridge.ts — forwards run lifecycle events to a Pixel Agents
// office server (spec 2026-11-04). Pixel Agents exposes a provider-agnostic hook ingest
// (POST /api/hooks/:id, Bearer auth, Claude-shaped payloads); hooks-only sessions appear
// as characters only when their "Watch All Sessions" setting is on, so the bridge pushes
// that setting once over its WebSocket after the first successful health check.
import type { OfficeConfig } from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { EventBus } from '../events/bus.ts';
import { outboxBounds, readOutboxAfter } from '../events/outbox.ts';

export interface HookEvent {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

interface BridgeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PixelAgentsBridgeDeps {
  db: AikDb;
  bus: EventBus;
  logger: BridgeLogger;
  redact: (text: string) => string;
  office: OfficeConfig;
  fetchImpl?: typeof fetch;
  webSocketImpl?: new (url: string) => WebSocket;
  healthIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  queueCap?: number;
  requestTimeoutMs?: number;
}

interface RunEventData {
  runId: number;
  role: string;
  storyKey: string;
  projectKey: string;
  status?: string;
  exitReason?: string;
}

function toRunEventData(data: unknown): RunEventData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== 'number' || typeof d.role !== 'string' || typeof d.storyKey !== 'string' || typeof d.projectKey !== 'string') {
    return null;
  }
  return {
    runId: d.runId,
    role: d.role,
    storyKey: d.storyKey,
    projectKey: d.projectKey,
    status: typeof d.status === 'string' ? d.status : undefined,
    exitReason: typeof d.exitReason === 'string' ? d.exitReason : undefined,
  };
}

const sessionIdOf = (runId: number): string => `aik-run-${runId}`;

/** Character spawn: SessionStart stages the session, PreToolUse confirms + shows the busy bubble. */
export function hookEventsForRunStarted(data: unknown): HookEvent[] {
  const d = toRunEventData(data);
  if (!d) return [];
  return [
    {
      session_id: sessionIdOf(d.runId),
      hook_event_name: 'SessionStart',
      source: 'startup',
      // The display label is basename(cwd); the path never needs to exist (hooks-only agent).
      cwd: `AIK/${d.projectKey}/${d.storyKey} ${d.role}`,
    },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'PreToolUse', tool_name: `aik-${d.role}`, tool_input: { story: d.storyKey } },
  ];
}

/** Character despawn: clear the tool bubble, flash Done, remove the character. */
export function hookEventsForRunFinished(data: unknown): HookEvent[] {
  const d = toRunEventData(data);
  if (!d) return [];
  return [
    { session_id: sessionIdOf(d.runId), hook_event_name: 'PostToolUse', tool_name: `aik-${d.role}`, tool_input: { story: d.storyKey } },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'Stop' },
    { session_id: sessionIdOf(d.runId), hook_event_name: 'SessionEnd', reason: 'exit' },
  ];
}

export class PixelAgentsBridge {
  private readonly db: AikDb;
  private readonly bus: EventBus;
  private readonly logger: BridgeLogger;
  private readonly redact: (text: string) => string;
  private readonly office: OfficeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: new (url: string) => WebSocket;
  private readonly healthIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly queueCap: number;
  private readonly requestTimeoutMs: number;

  private cursor = 0;
  private healthy = false;
  private settingsPushed = false;
  private draining = false;
  private queue: HookEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  // Overlapping poll() calls (start()'s initial cycle racing an interval- or caller-driven one)
  // would each see settingsPushed=false and open a duplicate settings WebSocket — coalesce them.
  private activePoll: Promise<void> | null = null;

  constructor(deps: PixelAgentsBridgeDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.logger = deps.logger;
    this.redact = deps.redact;
    this.office = deps.office;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.webSocketImpl = deps.webSocketImpl ?? WebSocket;
    this.healthIntervalMs = deps.healthIntervalMs ?? 5_000;
    this.retryDelaysMs = deps.retryDelaysMs ?? [500, 1500];
    this.queueCap = deps.queueCap ?? 100;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 5_000;
  }

  start(): void {
    // A restarted orchestrator never replays old runs (spec: characters appear on next event).
    this.cursor = outboxBounds(this.db).max ?? 0;
    this.unsubscribe = this.bus.subscribe(() => void this.drain());
    this.healthTimer = setInterval(() => void this.poll(), this.healthIntervalMs);
    void this.poll();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** One health check + settings push + drain cycle. Also driven by the interval. */
  async poll(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    this.activePoll = this.pollOnce();
    try {
      await this.activePoll;
    } finally {
      this.activePoll = null;
    }
  }

  private async pollOnce(): Promise<void> {
    await this.checkHealth();
    await this.drain();
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.office.url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) throw new Error(`health ${res.status}`);
      this.healthy = true;
      // The settings push is best-effort: a failure must not block flushing queued events —
      // it just means characters are not adopted until a later poll succeeds.
      if (!this.settingsPushed) {
        try {
          await this.pushWatchAllSessions();
        } catch (err) {
          this.logger.warn({ err: this.redact(err instanceof Error ? err.message : String(err)) }, 'pixel-agents settings push failed; will retry');
        }
      }
      await this.flush();
    } catch (err) {
      this.healthy = false;
      this.logger.warn({ err: this.redact(err instanceof Error ? err.message : String(err)) }, 'pixel-agents office unreachable; events are queued');
    }
  }

  /** Hooks-only sessions are dropped unless Watch All Sessions is on (verified in their source). */
  private async pushWatchAllSessions(): Promise<void> {
    const wsUrl = `${this.office.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.office.token)}`;
    const ws = new this.webSocketImpl(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws open timeout')), 3_000);
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        };
      });
      ws.send('{"type":"webviewReady"}');
      ws.send('{"type":"setWatchAllSessions","enabled":true}');
      this.settingsPushed = true;
    } finally {
      ws.close();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const env of readOutboxAfter(this.db, this.cursor)) {
        this.cursor = env.seq;
        if (env.topic === 'run.started' || env.topic === 'run.finished') {
          const events = env.topic === 'run.started' ? hookEventsForRunStarted(env.data) : hookEventsForRunFinished(env.data);
          for (const event of events) await this.deliver(event);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(event: HookEvent): Promise<void> {
    if (!this.healthy) {
      this.enqueue(event);
      return;
    }
    try {
      await this.post(event);
    } catch {
      this.healthy = false;
      this.enqueue(event);
    }
  }

  enqueue(event: HookEvent): void {
    this.queue.push(event);
    while (this.queue.length > this.queueCap) {
      const dropped = this.queue.shift();
      this.logger.warn({ session: dropped?.session_id }, 'office queue full; dropped oldest event');
    }
  }

  private async flush(): Promise<void> {
    while (this.healthy && this.queue.length > 0) {
      const event = this.queue[0];
      if (!event) break; // HookEvent | undefined under noUncheckedIndexedAccess; length check makes this unreachable
      try {
        await this.post(event);
        this.queue.shift();
      } catch {
        this.healthy = false;
        break;
      }
    }
  }

  /** POST one hook event; transport errors and 5xx are retried, 4xx is a permanent drop. */
  async post(event: HookEvent): Promise<void> {
    const url = `${this.office.url}/api/hooks/aik`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.office.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.status >= 500) throw new Error(`hook post ${res.status}`);
        if (!res.ok) {
          // 4xx: our payload is wrong — retrying cannot help; drop with a redacted warn.
          this.logger.warn({ status: res.status, session: event.session_id }, 'pixel-agents rejected a hook event');
          return;
        }
        return;
      } catch (err) {
        if (attempt >= this.retryDelaysMs.length) {
          const failure = err instanceof Error ? err : new Error(String(err));
          this.logger.warn({ err: this.redact(failure.message) }, 'pixel-agents hook post failed after retries');
          throw failure;
        }
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt] ?? 0));
      }
    }
  }
}
