import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ killTimes: [] as number[] }));

// Wrap the real tree-kill so the tests can count `taskkill` invocations without changing behaviour.
vi.mock('../src/process/tree-kill.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/process/tree-kill.ts')>();
  return {
    ...actual,
    killProcessTree: vi.fn((child: Parameters<typeof actual.killProcessTree>[0]) => {
      hoisted.killTimes.push(Date.now());
      return actual.killProcessTree(child);
    }),
  };
});

import { readPidRecords, removePidRecord, writePidRecord } from '../src/process/pid-records.ts';
import { UnsupportedCommandError } from '../src/process/project-command.ts';
import { spawnStreaming, validateSpawnFile, type StreamingProcess, type StreamingSpawnOptions } from '../src/process/spawn-streaming.ts';
import { killProcessTree } from '../src/process/tree-kill.ts';
import { makeTempDir } from './helpers/temp.ts';

const killSpy = vi.mocked(killProcessTree);
const NODE = process.execPath;

const live: StreamingProcess[] = [];

beforeEach(() => {
  killSpy.mockClear();
  hoisted.killTimes.length = 0;
});

afterEach(async () => {
  // Safety net only: never leave a child behind if an assertion failed mid-test.
  await Promise.all(live.splice(0).map((p) => p.killTree()));
});

function start(script: string, overrides: Partial<StreamingSpawnOptions> = {}) {
  const cwd = makeTempDir('aik-spawn-');
  const pidDir = path.join(makeTempDir('aik-pids-'), 'pids');
  const chunks: Buffer[] = [];
  const chunkTimes: number[] = [];
  const proc = spawnStreaming({
    runId: `run-${Math.random().toString(36).slice(2)}`,
    file: NODE,
    args: ['-e', script],
    cwd,
    env: process.env,
    stdinText: null,
    deadlineMs: 30_000,
    pidDir,
    onStdoutChunk: (chunk) => {
      chunks.push(chunk);
      chunkTimes.push(Date.now());
    },
    ...overrides,
  });
  live.push(proc);
  const stdout = () => Buffer.concat(chunks).toString('utf8');
  return { proc, cwd, pidDir, chunks, chunkTimes, stdout };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => (isAlive(pid) ? undefined : true), timeoutMs);
}

/** Spawns a grandchild, publishes its pid in the cwd, then idles. */
const TREE_SCRIPT = [
  "const cp = require('node:child_process');",
  "const fs = require('node:fs');",
  "const g = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)']);",
  "fs.writeFileSync('grandchild.pid', String(g.pid));",
  'setInterval(function () {}, 1000);',
].join(' ');

const IDLE_SCRIPT = 'setInterval(function () {}, 1000);';

describe('spawnStreaming argv', () => {
  test('argv elements arrive byte-identical, metacharacters included (no shell)', async () => {
    const specials = ['a&b', '"q"', '%PATH%', '$(x)', '^', '|', 'with space', '', 'trail\\', 'a\\"b', '>out', '!x!', '`id`'];
    const { proc, stdout } = start('process.stdout.write(JSON.stringify(process.argv.slice(1)))', {
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...specials],
    });
    const result = await proc.done;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toEqual(specials);
  });

  test('prefixArgs come before args', async () => {
    const { proc, stdout } = start('', {
      prefixArgs: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'],
      args: ['one', 'two'],
    });
    await proc.done;
    expect(JSON.parse(stdout())).toEqual(['one', 'two']);
  });

  test.each([
    ['C:\\tools\\agent.cmd'],
    ['C:\\tools\\agent.CMD'],
    ['C:\\tools\\agent.bat'],
    ['C:\\tools\\agent.ps1'],
    ['agent.exe'],
    ['node'],
    ['.\\node.exe'],
    ['tools\\node.exe'],
    ['\\tools\\node.exe'],
    [''],
  ])('refuses %j before spawning', (file) => {
    const pidDir = path.join(makeTempDir('aik-pids-'), 'pids');
    const onStdoutChunk = vi.fn();
    expect(() =>
      spawnStreaming({
        runId: 'refused',
        file,
        args: [],
        cwd: makeTempDir(),
        env: process.env,
        stdinText: 'x',
        deadlineMs: 1_000,
        pidDir,
        onStdoutChunk,
      }),
    ).toThrow(UnsupportedCommandError);
    expect(() => validateSpawnFile(file)).toThrow(UnsupportedCommandError);
    expect(readPidRecords(pidDir)).toEqual([]);
    expect(onStdoutChunk).not.toHaveBeenCalled();
  });

  test('accepts an absolute native executable', () => {
    expect(() => validateSpawnFile(NODE)).not.toThrow();
  });

  test.each([['../escape'], ['a/b'], ['a\\b'], ['..'], ['.'], ['']])('refuses unsafe runId %j before spawning', (runId) => {
    const pidDir = path.join(makeTempDir('aik-pids-'), 'pids');
    expect(() =>
      spawnStreaming({
        runId,
        file: NODE,
        args: ['-e', ''],
        cwd: makeTempDir(),
        env: process.env,
        stdinText: null,
        deadlineMs: 1_000,
        pidDir,
        onStdoutChunk: () => {},
      }),
    ).toThrow(/runId/);
    expect(readPidRecords(pidDir)).toEqual([]);
  });
});

describe('spawnStreaming stdin and stdout', () => {
  test('the child reads the full stdinText and then sees EOF', async () => {
    const text = `${'x'.repeat(200_000)}é-END`;
    const script = [
      'let n = 0; const parts = [];',
      "process.stdin.on('data', (c) => { parts.push(c); });",
      "process.stdin.on('end', () => { const s = Buffer.concat(parts).toString('utf8'); process.stdout.write('len:' + s.length + ':' + s.slice(-6)); });",
    ].join(' ');
    const { proc, stdout } = start(script, { stdinText: text, deadlineMs: 15_000 });
    const result = await proc.done;
    expect(result.timedOut).toBe(false); // stdin was closed, so the child did not wait for the deadline
    expect(result.exitCode).toBe(0);
    expect(stdout()).toBe(`len:${text.length}:é-END`);
  });

  test('stdinText null still closes stdin', async () => {
    const { proc, stdout } = start("process.stdin.on('data', () => {}); process.stdin.on('end', () => process.stdout.write('eof'));", {
      deadlineMs: 15_000,
    });
    const result = await proc.done;
    expect(result.timedOut).toBe(false);
    expect(stdout()).toBe('eof');
  });

  test('stdout chunks are handed over as they arrive, before the child exits', async () => {
    const script = "process.stdout.write('first\\n'); setTimeout(() => { process.stdout.write('second\\n'); }, 1000);";
    const { proc, chunks, chunkTimes, stdout } = start(script);
    const result = await proc.done;
    const doneAt = Date.now();
    expect(result.exitCode).toBe(0);
    expect(chunks[0]!.toString('utf8')).toContain('first');
    expect(chunks[0]!.toString('utf8')).not.toContain('second');
    expect(doneAt - chunkTimes[0]!).toBeGreaterThanOrEqual(700);
    expect(stdout()).toBe('first\nsecond\n');
  });

  test('stderr is captured as a tail and forwarded', async () => {
    const seen: Buffer[] = [];
    const { proc } = start("process.stderr.write('a'.repeat(20000) + 'TAIL-END'); process.exitCode = 4;", {
      onStderr: (c) => seen.push(c),
    });
    const result = await proc.done;
    expect(result.exitCode).toBe(4);
    expect(result.stderrTail.endsWith('TAIL-END')).toBe(true);
    expect(result.stderrTail.length).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.concat(seen).toString('utf8')).toHaveLength(20000 + 'TAIL-END'.length);
  });

  test('a spawn failure (missing executable) rejects done', async () => {
    const missing = path.join(makeTempDir(), 'missing.exe');
    const { proc, pidDir } = start('', { file: missing });
    await expect(proc.done).rejects.toThrow();
    expect(readPidRecords(pidDir)).toEqual([]);
  });
});

describe('spawnStreaming deadline and kill', () => {
  test('deadline kills the tree: timedOut within deadline + 2 s and the grandchild is gone', async () => {
    const deadlineMs = 2_000;
    const startedAt = Date.now();
    const { proc, cwd } = start(TREE_SCRIPT, { deadlineMs });
    const pidFile = path.join(cwd, 'grandchild.pid');
    const grandchildPid = await waitFor(() => {
      if (!fs.existsSync(pidFile)) return undefined;
      const n = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    expect(isAlive(grandchildPid)).toBe(true);

    const result = await proc.done;
    expect(result.timedOut).toBe(true);
    expect(result.interrupted).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(deadlineMs + 2_000);
    expect(killSpy).toHaveBeenCalledTimes(1);
    await waitForProcessExit(grandchildPid, 3_000);
  }, 20_000);

  test('killTree() twice (and again after exit) runs one taskkill', async () => {
    const { proc } = start(IDLE_SCRIPT);
    await waitFor(() => (proc.pid !== undefined ? true : undefined));
    const a = proc.killTree();
    const b = proc.killTree();
    expect(a).toBe(b); // one shared promise
    await Promise.all([a, b]);
    const result = await proc.done;
    await proc.killTree();
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(false);
  }, 20_000);

  test('killTree() after a natural exit is a no-op', async () => {
    const { proc } = start('process.exit(0)');
    await proc.done;
    await expect(proc.killTree()).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('spawnStreaming interrupt()', () => {
  test('a child that exits by itself within the grace period is not killed', async () => {
    const { proc } = start("setTimeout(() => process.exit(0), 1500); setInterval(function () {}, 1000);");
    const startedAt = Date.now();
    await proc.interrupt();
    const elapsed = Date.now() - startedAt;
    const result = await proc.done;
    expect(killSpy).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(4_000);
  }, 20_000);

  test('a child that ignores the stop is tree-killed after 5 s ± 1 s', async () => {
    const { proc, cwd } = start(TREE_SCRIPT);
    const pidFile = path.join(cwd, 'grandchild.pid');
    const grandchildPid = await waitFor(() => {
      if (!fs.existsSync(pidFile)) return undefined;
      const n = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    const startedAt = Date.now();
    await proc.interrupt();
    const result = await proc.done;
    expect(killSpy).toHaveBeenCalledTimes(1);
    const killedAfter = hoisted.killTimes[0]! - startedAt;
    expect(killedAfter).toBeGreaterThanOrEqual(4_000);
    expect(killedAfter).toBeLessThanOrEqual(6_000);
    expect(result.interrupted).toBe(true);
    expect(result.timedOut).toBe(false);
    await waitForProcessExit(grandchildPid, 3_000);
  }, 20_000);

  test('interrupt() twice shares one wait; after exit it is a no-op', async () => {
    const { proc } = start("setTimeout(() => process.exit(0), 500); setInterval(function () {}, 1000);");
    await Promise.all([proc.interrupt(), proc.interrupt()]);
    await proc.done;
    await expect(proc.interrupt()).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  }, 20_000);
});

describe('PID records', () => {
  test('a record with image and start time exists while running and is removed on exit', async () => {
    const before = Date.now();
    const { proc, pidDir } = start(IDLE_SCRIPT);
    const records = readPidRecords(pidDir);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.pid).toBe(proc.pid);
    expect(record!.image).toBe(path.basename(NODE));
    const startMs = Date.parse(record!.startTime);
    expect(Number.isNaN(startMs)).toBe(false);
    expect(startMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(startMs).toBeLessThanOrEqual(Date.now());
    expect(fs.readdirSync(pidDir)).toEqual([`${record!.runId}.json`]);

    await proc.killTree();
    await proc.done;
    expect(readPidRecords(pidDir)).toEqual([]);
    expect(fs.readdirSync(pidDir)).toEqual([]);
  }, 20_000);

  test('the record is also removed after a natural exit', async () => {
    const { proc, pidDir } = start('process.exit(0)');
    await proc.done;
    expect(readPidRecords(pidDir)).toEqual([]);
  });

  test('readPidRecords: a missing directory reads as empty; malformed files are skipped', () => {
    const root = makeTempDir('aik-pids-');
    expect(readPidRecords(path.join(root, 'nope'))).toEqual([]);
    writePidRecord(root, 'good-1', { pid: 1234, image: 'codex.exe', startTime: '2026-11-07T10:00:00.000Z' });
    fs.writeFileSync(path.join(root, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(root, 'wrong.json'), JSON.stringify({ pid: 'x' }));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'ignored');
    expect(readPidRecords(root)).toEqual([{ runId: 'good-1', pid: 1234, image: 'codex.exe', startTime: '2026-11-07T10:00:00.000Z' }]);
  });

  test('removePidRecord only removes the record of the given pid', () => {
    const root = makeTempDir('aik-pids-');
    writePidRecord(root, 'r1', { pid: 10, image: 'node.exe', startTime: '2026-11-07T10:00:00.000Z' });
    removePidRecord(root, 'r1', 11);
    expect(readPidRecords(root)).toHaveLength(1);
    removePidRecord(root, 'r1', 10);
    expect(readPidRecords(root)).toEqual([]);
    expect(() => removePidRecord(root, 'r1', 10)).not.toThrow();
  });

  test('writePidRecord refuses an unsafe runId', () => {
    const root = makeTempDir('aik-pids-');
    expect(() => writePidRecord(root, '../x', { pid: 1, image: 'node.exe', startTime: '2026-11-07T10:00:00.000Z' })).toThrow(/runId/);
  });
});
