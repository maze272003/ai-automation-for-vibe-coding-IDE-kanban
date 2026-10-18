import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrchestratorSupervisor, type ChildLike } from '../src/main/supervisor.ts';

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  sent: unknown[] = [];
  killed = false;
  exitOnShutdown = true;
  postMessage(message: unknown): void {
    this.sent.push(message);
    if ((message as { type: string }).type === 'shutdown' && this.exitOnShutdown) queueMicrotask(() => this.emit('exit', 0));
  }
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 1);
    return true;
  }
}

let children: FakeChild[];
let timers: { fn: () => void; ms: number }[];
let now: number;
let sup: OrchestratorSupervisor;

beforeEach(() => {
  children = [];
  timers = [];
  now = 0;
  sup = new OrchestratorSupervisor({
    fork: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    initMessage: () => ({ type: 'init', token: 't' }),
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
});

const last = () => children.at(-1)!;
const runTimer = () => timers.shift()!.fn();

describe('OrchestratorSupervisor', () => {
  it('forks, sends init and becomes ready', () => {
    const ready: number[] = [];
    sup.on('ready', (p: number) => ready.push(p));
    sup.start();
    expect(last().sent).toEqual([{ type: 'init', token: 't' }]);
    expect(sup.state).toBe('starting');
    last().emit('message', { type: 'ready', port: 5555 });
    expect([sup.state, sup.port, ready]).toEqual(['ready', 5555, [5555]]);
  });

  it('restarts with exponential backoff and resets it after a successful start', () => {
    sup.start();
    last().emit('exit', 1);
    expect([sup.state, sup.port, timers.map((t) => t.ms)]).toEqual(['restarting', null, [1000]]);
    runTimer();
    last().emit('exit', 1);
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    runTimer();
    last().emit('message', { type: 'ready', port: 1 });
    last().emit('exit', 1);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
  });

  it('enters crash-loop after more than 5 crashes within 5 minutes', () => {
    sup.start();
    for (let i = 0; i < 5; i++) {
      last().emit('exit', 1);
      now += 1000;
      runTimer();
    }
    last().emit('exit', 1);
    expect(sup.state).toBe('crash-loop');
    expect(timers).toHaveLength(0);
  });

  it('does not count crashes older than the window', () => {
    sup.start();
    for (let i = 0; i < 6; i++) {
      last().emit('exit', 1);
      now += 61_000;
      runTimer();
    }
    expect(sup.state).toBe('starting');
  });

  it('stays down on a fatal report', () => {
    sup.start();
    last().emit('message', { type: 'fatal', kind: 'database_corrupt', message: 'bad' });
    last().emit('exit', 3);
    expect([sup.state, sup.fatal]).toEqual(['fatal', { kind: 'database_corrupt', message: 'bad' }]);
    expect(timers).toHaveLength(0);
  });

  it('ignores messages and exits from a replaced child', () => {
    sup.start();
    const old = last();
    old.emit('exit', 1);
    runTimer();
    old.emit('message', { type: 'ready', port: 9 });
    expect(sup.port).toBeNull();
  });

  it('stops gracefully, or kills after the timeout', async () => {
    sup.start();
    await sup.stop(50);
    expect(sup.state).toBe('stopped');
    expect(last().sent.at(-1)).toEqual({ type: 'shutdown' });
    expect(timers).toHaveLength(0);

    sup.start();
    last().exitOnShutdown = false;
    await sup.stop(20);
    expect(last().killed).toBe(true);
  });

  it('restart() clears crash-loop and fatal state', () => {
    sup.start();
    last().emit('message', { type: 'fatal', kind: 'startup_failed', message: 'x' });
    last().emit('exit', 3);
    sup.restart();
    expect([sup.state, sup.fatal, children.length]).toEqual(['starting', null, 2]);
  });
});
