import { describe, expect, it } from 'vitest';
import { RunInterruptRegistry } from '../src/agents/interrupts.ts';

describe('RunInterruptRegistry', () => {
  it('register keeps one slot per story and replaces the previous handle (I10)', () => {
    const reg = new RunInterruptRegistry();
    const first = { runId: 1, stop: () => {} };
    const second = { runId: 2, stop: () => {} };
    reg.register(10, first);
    expect(reg.active(10)).toBe(first);
    reg.register(10, second);
    expect(reg.active(10)).toBe(second);
    expect(reg.activeStoryIds()).toEqual([10]);
  });

  it('unregister clears both the handle and the stop flag', async () => {
    const reg = new RunInterruptRegistry();
    const stops: number[] = [];
    reg.register(10, { runId: 1, stop: () => { stops.push(1); } });
    await reg.requestStop(10);
    expect(reg.isStopRequested(10)).toBe(true);
    reg.unregister(10);
    expect(reg.active(10)).toBeUndefined();
    expect(reg.isStopRequested(10)).toBe(false);
    expect(reg.activeStoryIds()).toEqual([]);
  });

  it('requestStop sets the flag and invokes the registered stop()', async () => {
    const reg = new RunInterruptRegistry();
    const calls: number[] = [];
    reg.register(7, { runId: 42, stop: () => { calls.push(42); } });
    await reg.requestStop(7);
    expect(calls).toEqual([42]);
    expect(reg.isStopRequested(7)).toBe(true);
  });

  it('a throwing stop() is swallowed; the flag alone still aborts the local loop', async () => {
    const reg = new RunInterruptRegistry();
    reg.register(7, { runId: 42, stop: () => { throw new Error('opencode unreachable'); } });
    await expect(reg.requestStop(7)).resolves.toBeUndefined();
    expect(reg.isStopRequested(7)).toBe(true);
  });

  it('an async stop() rejection is swallowed too', async () => {
    const reg = new RunInterruptRegistry();
    reg.register(7, { runId: 42, stop: async () => { throw new Error('session wedged'); } });
    await expect(reg.requestStop(7)).resolves.toBeUndefined();
    expect(reg.isStopRequested(7)).toBe(true);
  });

  it('the stop flag works with no registered handle (fail-safe)', async () => {
    const reg = new RunInterruptRegistry();
    await expect(reg.requestStop(99)).resolves.toBeUndefined();
    expect(reg.isStopRequested(99)).toBe(true);
    expect(reg.active(99)).toBeUndefined();
  });

  it('activeStoryIds tracks registrations across stories', () => {
    const reg = new RunInterruptRegistry();
    reg.register(1, { stop: () => {} });
    reg.register(2, { runId: 5, stop: () => {} });
    expect([...reg.activeStoryIds()].sort((a, b) => a - b)).toEqual([1, 2]);
    reg.unregister(1);
    expect(reg.activeStoryIds()).toEqual([2]);
  });
});
