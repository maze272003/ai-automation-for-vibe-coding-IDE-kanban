// apps/desktop/test/terminal.test.ts — Task 3: TerminalManager unit tests (Phase 5.3
// spec §Component design 2). All pty/schedule/killTree/send dependencies are fakes:
// no process is ever spawned and taskkill is never invoked here.
import { TERMINAL_MAX_SESSIONS } from '@aik/contracts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { assertInTemp, makeTempDir } from '../../orchestrator/test/helpers/temp.ts';
import { TerminalManager, type OwnerLike, type PtyLike, type PtySpawnOptions } from '../src/main/terminal.ts';

/** Fake pty: records write/resize/kill calls, emits data/exit manually. */
class FakePty implements PtyLike {
  readonly pid: number;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  writeShouldThrow = false;
  resizeShouldThrow = false;
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(event: { exitCode: number }) => void> = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(cb: (data: string) => void): void {
    this.dataHandlers.push(cb);
  }

  onExit(cb: (event: { exitCode: number }) => void): void {
    this.exitHandlers.push(cb);
  }

  write(data: string): void {
    if (this.writeShouldThrow) throw new Error('write on exited pty');
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeShouldThrow) throw new Error('resize on exited pty');
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  emitData(data: string): void {
    for (const cb of [...this.dataHandlers]) cb(data);
  }

  emitExit(exitCode: number): void {
    for (const cb of [...this.exitHandlers]) cb({ exitCode });
  }
}

/** Fake owner: a plain EventEmitter with a webContents-style id. */
class FakeOwner extends EventEmitter implements OwnerLike {
  constructor(readonly id: number) {
    super();
  }
}

/** Fake owner whose destruction can be toggled (the webContents.isDestroyed seam). */
class CheckedOwner extends FakeOwner {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  options: PtySpawnOptions;
}

const makeHarness = () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const queue: Array<() => void> = [];
  const spawnCalls: SpawnCall[] = [];
  const killedTrees: number[] = [];
  const ptys: FakePty[] = [];
  let nextPid = 4242;
  const manager = new TerminalManager({
    createPty: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      const pty = new FakePty(nextPid++);
      ptys.push(pty);
      return pty;
    },
    schedule: (cb) => queue.push(cb),
    killTree: (pid) => killedTrees.push(pid),
    send: (channel, payload) => sent.push({ channel, payload }),
  });
  const drain = (): void => {
    while (queue.length > 0) queue.shift()?.();
  };
  return { manager, sent, spawnCalls, killedTrees, ptys, drain };
};

const temps: string[] = [];
const tempDir = (): string => {
  const dir = makeTempDir('aik-terminal-');
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('terminal manager', () => {
  test('open spawns %COMSPEC% with the resolved cwd/grid/env and hands out monotonic ids', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(7);
    const dir = tempDir();
    const first = await h.manager.open({ cwd: dir, cols: 120, rows: 30 }, owner);
    expect(first).toEqual({ ok: true, id: 1, cwd: dir }); // cwd returned exactly as resolved
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0]?.file).toBe(process.env.COMSPEC ?? 'cmd.exe');
    expect(h.spawnCalls[0]?.args).toEqual([]);
    expect(h.spawnCalls[0]?.options).toMatchObject({ name: 'xterm-256color', cols: 120, rows: 30, cwd: dir });
    expect(h.spawnCalls[0]?.options.env).toBe(process.env);
    const second = await h.manager.open({ cwd: dir, cols: 80, rows: 24 }, owner);
    expect(second).toEqual({ ok: true, id: 2, cwd: dir });
    expect(h.manager.sessionsInfo()).toEqual([
      { id: 1, pid: h.ptys[0]?.pid },
      { id: 2, pid: h.ptys[1]?.pid },
    ]);
  });

  test('a throwing pty factory maps to SPAWN_FAILED and consumes no id', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const manager = new TerminalManager({
      createPty: () => {
        throw new Error('no ConPTY');
      },
      schedule: () => {},
      killTree: () => {},
      send: (channel, payload) => sent.push({ channel, payload }),
    });
    const failed = await manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    expect(failed).toEqual({ ok: false, reason: 'SPAWN_FAILED', message: 'no ConPTY' });
    const retried = await manager.open({ cols: 80, rows: 24 }, new FakeOwner(1)); // every open consults the factory — a retry fails the same way
    expect(retried).toEqual({ ok: false, reason: 'SPAWN_FAILED', message: 'no ConPTY' });
    expect(sent).toEqual([]);
    expect(manager.sessionsInfo()).toEqual([]);
  });

  test('cwd validation accepts an existing directory and rejects missing paths and files', async () => {
    const h = makeHarness();
    const dir = tempDir();
    const existing = await h.manager.open({ cwd: dir, cols: 80, rows: 24 }, new FakeOwner(1));
    expect(existing).toEqual({ ok: true, id: 1, cwd: dir });
    expect(() => assertInTemp(dir)).not.toThrow(); // repo rule: only OS-temp paths in tests
    const missing = await h.manager.open({ cwd: path.join(tempDir(), 'no-such-dir'), cols: 80, rows: 24 }, new FakeOwner(1));
    expect(missing).toEqual({ ok: false, reason: 'INVALID_CWD' });
    const filePath = path.join(tempDir(), 'plain-file.txt');
    fs.writeFileSync(filePath, 'not a directory');
    const notDir = await h.manager.open({ cwd: filePath, cols: 80, rows: 24 }, new FakeOwner(1));
    expect(notDir).toEqual({ ok: false, reason: 'INVALID_CWD' });
    const home = await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    expect(home).toEqual({ ok: true, id: 2, cwd: os.homedir() }); // absent cwd → homedir, verbatim
    expect(h.spawnCalls.length).toBe(2); // failed opens never spawned
  });

  test('the session cap refuses the ninth open with TOO_MANY_SESSIONS', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(1);
    for (let i = 0; i < TERMINAL_MAX_SESSIONS; i++) {
      const opened = await h.manager.open({ cols: 80, rows: 24 }, owner);
      expect(opened.ok).toBe(true);
    }
    const ninth = await h.manager.open({ cols: 80, rows: 24 }, owner);
    expect(ninth).toEqual({ ok: false, reason: 'TOO_MANY_SESSIONS' });
    expect(h.spawnCalls.length).toBe(TERMINAL_MAX_SESSIONS);
  });

  test('write/resize route to the owning session; unknown ids and throwing ptys return false', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(1);
    await h.manager.open({ cols: 80, rows: 24 }, owner);
    await h.manager.open({ cols: 80, rows: 24 }, owner);
    expect(h.manager.write(1, 'dir')).toBe(true);
    expect(h.manager.write(999, 'x')).toBe(false);
    expect(h.ptys[0]?.writes).toEqual(['dir']);
    expect(h.ptys[1]?.writes).toEqual([]);
    expect(h.manager.resize(2, 100, 40)).toBe(true);
    expect(h.manager.resize(999, 100, 40)).toBe(false);
    expect(h.ptys[0]?.resizes).toEqual([]);
    expect(h.ptys[1]?.resizes).toEqual([{ cols: 100, rows: 40 }]);
    // node-pty throws on write/resize of an exited-but-undeleted session — swallowed (spec T-12)
    h.ptys[0]!.writeShouldThrow = true;
    h.ptys[0]!.resizeShouldThrow = true;
    expect(h.manager.write(1, 'boom')).toBe(false);
    expect(h.manager.resize(1, 100, 40)).toBe(false);
  });

  test('output chunks coalesce into one ordered flush and the exit tail precedes the exit event', async () => {
    const h = makeHarness();
    await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    h.ptys[0]!.emitData('hel');
    h.ptys[0]!.emitData('lo');
    expect(h.sent).toEqual([]); // nothing is sent until the scheduler drains
    h.drain();
    expect(h.sent).toEqual([{ channel: 'aik:terminal-data', payload: { id: 1, data: 'hello' } }]);
    h.ptys[0]!.emitData('tail');
    h.ptys[0]!.emitExit(0);
    expect(h.sent).toEqual([
      { channel: 'aik:terminal-data', payload: { id: 1, data: 'hello' } },
      { channel: 'aik:terminal-data', payload: { id: 1, data: 'tail' } },
      { channel: 'aik:terminal-exit', payload: { id: 1, exitCode: 0 } },
    ]);
    h.drain(); // the queued flush for 'tail' is a no-op now — the session is gone
    expect(h.sent.length).toBe(3);
  });

  test('an exit deletes the session: later writes fail and a duplicate exit is ignored', async () => {
    const h = makeHarness();
    await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    h.ptys[0]!.emitExit(3);
    expect(h.sent).toEqual([{ channel: 'aik:terminal-exit', payload: { id: 1, exitCode: 3 } }]);
    expect(h.manager.sessionsInfo()).toEqual([]);
    expect(h.manager.write(1, 'x')).toBe(false);
    h.ptys[0]!.emitExit(4); // a late duplicate exit must be inert
    expect(h.sent.length).toBe(1);
  });

  test('close kills the pty and its process tree, deletes the session, idempotently', async () => {
    const h = makeHarness();
    await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    const pid = h.ptys[0]!.pid;
    expect(h.manager.close(1)).toBe(true);
    expect(h.ptys[0]!.killCount).toBe(1);
    expect(h.killedTrees).toEqual([pid]);
    expect(h.manager.sessionsInfo()).toEqual([]);
    expect(h.manager.close(1)).toBe(false); // already dropped — no second kill
    expect(h.ptys[0]!.killCount).toBe(1);
    expect(h.killedTrees).toEqual([pid]);
  });

  test('killAll kills every session exactly once, sends nothing, and repeated calls no-op', async () => {
    const h = makeHarness();
    const ownerA = new FakeOwner(1);
    const ownerB = new FakeOwner(2);
    await h.manager.open({ cols: 80, rows: 24 }, ownerA);
    await h.manager.open({ cols: 80, rows: 24 }, ownerA);
    await h.manager.open({ cols: 80, rows: 24 }, ownerB);
    h.manager.killAll();
    expect(h.ptys.map((p) => p.killCount)).toEqual([1, 1, 1]);
    expect([...h.killedTrees].sort((a, b) => a - b)).toEqual([...h.ptys.map((p) => p.pid)].sort((a, b) => a - b));
    expect(h.manager.sessionsInfo()).toEqual([]);
    expect(h.sent).toEqual([]); // killAll never sends — the window is going away
    h.manager.killAll();
    expect(h.ptys.map((p) => p.killCount)).toEqual([1, 1, 1]);
    expect(h.killedTrees.length).toBe(3);
  });

  test("owner lifetime events kill only that owner's sessions and re-arm for new ones", async () => {
    const h = makeHarness();
    const ownerA = new FakeOwner(1);
    const ownerB = new FakeOwner(2);
    await h.manager.open({ cols: 80, rows: 24 }, ownerA);
    await h.manager.open({ cols: 80, rows: 24 }, ownerA);
    await h.manager.open({ cols: 80, rows: 24 }, ownerB);
    ownerA.emit('did-start-navigation'); // bare emit, no details — treated as a real navigation → kill (leak-safe)
    expect(h.ptys[0]?.killCount).toBe(1);
    expect(h.ptys[1]?.killCount).toBe(1);
    expect(h.ptys[2]?.killCount).toBe(0); // the other owner is untouched
    expect(h.manager.sessionsInfo()).toEqual([{ id: 3, pid: h.ptys[2]?.pid }]);
    expect(ownerA.listenerCount('destroyed')).toBe(0); // idle owner — hooks disarmed
    expect(ownerB.listenerCount('destroyed')).toBe(1);
    const reopened = await h.manager.open({ cols: 80, rows: 24 }, ownerA); // hooks re-arm
    expect(reopened).toEqual({ ok: true, id: 4, cwd: os.homedir() });
    ownerA.emit('render-process-gone'); // renderer crash
    expect(h.ptys[3]?.killCount).toBe(1);
    expect(h.manager.sessionsInfo()).toEqual([{ id: 3, pid: h.ptys[2]?.pid }]);
    ownerB.emit('destroyed');
    expect(h.ptys[2]?.killCount).toBe(1);
    expect(h.manager.sessionsInfo()).toEqual([]);
  });

  test('did-start-navigation with isSameDocument:true (SPA route change) spares the session and the buffer keeps flowing', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(1);
    await h.manager.open({ cols: 80, rows: 24 }, owner);
    owner.emit('did-start-navigation', { isSameDocument: true }); // TanStack pushState
    expect(h.ptys[0]?.killCount).toBe(0); // the live session survives in-app navigation
    expect(h.manager.sessionsInfo()).toEqual([{ id: 1, pid: h.ptys[0]?.pid }]);
    h.ptys[0]!.emitData('still alive');
    h.drain();
    expect(h.sent).toEqual([{ channel: 'aik:terminal-data', payload: { id: 1, data: 'still alive' } }]);
    owner.emit('render-process-gone'); // the other lifetime events stay unconditional
    expect(h.ptys[0]?.killCount).toBe(1);
    expect(h.manager.sessionsInfo()).toEqual([]);
  });

  test('did-start-navigation kills only on real navigations: isSameDocument:false, or a bare emit (no details)', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(1);
    await h.manager.open({ cols: 80, rows: 24 }, owner);
    owner.emit('did-start-navigation', { isSameDocument: false }); // hard reload
    expect(h.ptys[0]?.killCount).toBe(1);
    expect(h.manager.sessionsInfo()).toEqual([]);
    const reopened = await h.manager.open({ cols: 80, rows: 24 }, owner); // hooks re-armed
    expect(reopened.ok).toBe(true);
    owner.emit('did-start-navigation'); // missing details → real navigation → kill (leak-safe)
    expect(h.ptys[1]?.killCount).toBe(1);
    expect(h.manager.sessionsInfo()).toEqual([]);
  });

  test('killAll() racing open() during the stat await refuses the spawn: no session, no pty', async () => {
    const h = makeHarness();
    const opening = h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    h.manager.killAll(); // runs while open is still awaiting fs.stat
    expect(await opening).toEqual({ ok: false, reason: 'SPAWN_FAILED', message: 'terminal manager is shutting down' });
    expect(h.spawnCalls).toEqual([]);
    expect(h.manager.sessionsInfo()).toEqual([]);
    const later = await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(2)); // disposed is sticky
    expect(later).toEqual({ ok: false, reason: 'SPAWN_FAILED', message: 'terminal manager is shutting down' });
  });

  test('open() refuses to spawn for an owner that reports isDestroyed after the stat await', async () => {
    const h = makeHarness();
    const dead = new CheckedOwner(1);
    dead.destroyed = true;
    expect(await h.manager.open({ cols: 80, rows: 24 }, dead)).toEqual({
      ok: false,
      reason: 'SPAWN_FAILED',
      message: 'terminal owner is destroyed',
    });
    expect(h.spawnCalls).toEqual([]); // no pty was created for the dead owner
    const alive = new CheckedOwner(2); // explicit isDestroyed():false (fakes omitting it are covered by every other test)
    expect((await h.manager.open({ cols: 80, rows: 24 }, alive)).ok).toBe(true);
    expect(h.spawnCalls.length).toBe(1);
  });

  test('a throwing send never propagates: flush and exit sends are swallowed and the session still dies', async () => {
    const queue: Array<() => void> = [];
    const pty = new FakePty(7777);
    const manager = new TerminalManager({
      createPty: () => pty,
      schedule: (cb) => queue.push(cb),
      killTree: () => {},
      send: () => {
        throw new Error('webContents.send is gone'); // e.g. the window died mid-flight
      },
    });
    expect((await manager.open({ cols: 80, rows: 24 }, new FakeOwner(1))).ok).toBe(true);
    pty.emitData('chunk');
    expect(() => {
      while (queue.length > 0) queue.shift()?.();
    }).not.toThrow(); // flush's send throws → swallowed, nothing escapes into the scheduler
    expect(() => pty.emitExit(0)).not.toThrow(); // exit's send throws → swallowed inside node-pty's callback
    expect(manager.sessionsInfo()).toEqual([]); // the session was still deleted after exit
  });

  test('owner hooks are unsubscribed after killAll (no listener leak)', async () => {
    const h = makeHarness();
    const owner = new FakeOwner(1);
    await h.manager.open({ cols: 80, rows: 24 }, owner);
    for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
      expect(owner.listenerCount(event)).toBe(1);
    }
    h.manager.killAll();
    for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
      expect(owner.listenerCount(event)).toBe(0);
    }
  });

  test('pty events for a dropped session (closed or exited) never reach send', async () => {
    const h = makeHarness();
    await h.manager.open({ cols: 80, rows: 24 }, new FakeOwner(1));
    h.ptys[0]!.emitData('kept');
    h.drain();
    h.manager.close(1);
    h.ptys[0]!.emitData('orphaned'); // flush drops the deleted session's buffer
    h.drain();
    h.ptys[0]!.emitExit(0); // late exit for a closed session — silent too
    expect(h.sent).toEqual([{ channel: 'aik:terminal-data', payload: { id: 1, data: 'kept' } }]);
    h.ptys[0]!.emitData('after-exit'); // and after an exit-deleted session
    h.drain();
    expect(h.sent.length).toBe(1);
  });
});
