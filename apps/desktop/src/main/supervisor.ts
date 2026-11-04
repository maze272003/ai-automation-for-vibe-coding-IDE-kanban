import type { OrchestratorState, SystemState } from '@aik/contracts';
import { EventEmitter } from 'node:events';
import { restartDelay } from './backoff.ts';

export interface ChildLike {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface SupervisorOptions {
  fork: () => ChildLike;
  initMessage: () => Record<string, unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  schedule?: readonly number[];
  crashWindowMs?: number;
  maxCrashes?: number;
}

type Fatal = NonNullable<SystemState['fatal']>;

/** Keeps exactly one orchestrator utility process alive (spec §6.10). */
export class OrchestratorSupervisor extends EventEmitter {
  state: OrchestratorState = 'stopped';
  port: number | null = null;
  /** The orchestrator's model-gateway port (managed mode); null before ready / without a gateway. */
  gatewayPort: number | null = null;
  fatal: Fatal | null = null;
  child: ChildLike | null = null;

  private readonly opts: Required<Omit<SupervisorOptions, 'schedule'>> & { schedule?: readonly number[] };
  private crashes: number[] = [];
  private consecutive = 0;
  private stopping = false;
  private restarting: Promise<void> | null = null;

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = {
      now: () => Date.now(),
      setTimer: (fn, ms) => void setTimeout(fn, ms),
      crashWindowMs: 5 * 60_000,
      maxCrashes: 5,
      ...opts,
    };
  }

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  /**
   * Replace the orchestrator with a fresh process so the next init message (e.g. a
   * toggled agent-office config, a restored backup, a provider change) actually
   * takes effect: a live child is stopped first (shutdown, bounded, then kill) and
   * respawned; a dead one respawns directly. Overlapping calls coalesce into a
   * single replacement — the second caller's state resets still apply.
   */
  restart(): void {
    this.crashes = [];
    this.consecutive = 0;
    this.fatal = null;
    if (this.restarting || this.stopping) return;
    if (this.child === null) {
      this.stopping = false;
      this.spawn();
      return;
    }
    // stop() flips `stopping` so the old child's exit cannot schedule a backoff
    // respawn next to ours; flip it back before spawning the replacement.
    this.restarting = this.stop().then(() => {
      this.restarting = null;
      this.stopping = false;
      this.spawn();
    });
  }

  async stop(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, timeoutMs);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'shutdown' });
    });
    this.setState('stopped');
  }

  private spawn(): void {
    this.port = null;
    this.gatewayPort = null;
    this.setState('starting');
    const child = this.opts.fork();
    this.child = child;
    child.on('message', (m) => this.onMessage(child, m));
    child.on('exit', (code) => this.onExit(child, code));
    child.postMessage(this.opts.initMessage());
  }

  private onMessage(child: ChildLike, message: unknown): void {
    if (child !== this.child) return;
    const m = message as { type?: string; port?: number; gatewayPort?: number; kind?: Fatal['kind']; message?: string };
    if (m.type === 'ready' && typeof m.port === 'number') {
      this.port = m.port;
      if (typeof m.gatewayPort === 'number') this.gatewayPort = m.gatewayPort;
      this.consecutive = 0;
      this.setState('ready');
      this.emit('ready', m.port, this.gatewayPort);
    } else if (m.type === 'fatal' && m.kind) {
      this.fatal = { kind: m.kind, message: m.message ?? '' };
      this.setState('fatal');
      this.emit('fatal', this.fatal);
    }
  }

  private onExit(child: ChildLike, code: number): void {
    if (child !== this.child) return;
    this.child = null;
    this.port = null;
    this.emit('down', code);
    if (this.stopping || this.state === 'fatal') return;
    const t = this.opts.now();
    this.crashes = [...this.crashes.filter((c) => t - c < this.opts.crashWindowMs), t];
    if (this.crashes.length > this.opts.maxCrashes) {
      this.setState('crash-loop');
      this.emit('crash-loop');
      return;
    }
    const delay = restartDelay(this.consecutive, this.opts.schedule);
    this.consecutive += 1;
    this.setState('restarting');
    this.opts.setTimer(() => {
      if (!this.stopping && this.child === null && this.state === 'restarting') this.spawn();
    }, delay);
  }

  private setState(state: OrchestratorState): void {
    this.state = state;
    this.emit('state', state);
  }
}
