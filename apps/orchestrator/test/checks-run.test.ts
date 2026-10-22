import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkEnvironment,
  parseCommand,
  runCheckCommand,
  UnsupportedCommandError,
  type SpawnedCheckProcess,
} from '../src/checks/run.ts';
import { makeTempDir } from './helpers/temp.ts';

describe('parseCommand', () => {
  test('splits argv and honours simple quotes', () => {
    expect(parseCommand('npm run test -- --grep "a b"')).toEqual({
      file: 'npm',
      args: ['run', 'test', '--', '--grep', 'a b'],
    });
    expect(parseCommand(`node -e "console.log('x')"`).args).toEqual(['-e', "console.log('x')"]);
  });

  test('refuses shell operators and expansion', () => {
    for (const command of ['npm test && rm -rf x', 'npm test | tee out', 'echo $HOME', 'echo %PATH%', 'echo `whoami`']) {
      expect(() => parseCommand(command)).toThrow(UnsupportedCommandError);
    }
    expect(() => parseCommand('echo "unterminated')).toThrow(UnsupportedCommandError);
  });
});

describe('checkEnvironment', () => {
  test('removes GitHub, provider and credential variables while keeping the toolchain', () => {
    const env = checkEnvironment({
      PATH: '/bin',
      HOME: '/home/u',
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      OPENAI_API_KEY: 'x',
      AIKANBAN_CRED_PIPE: 'x',
      MY_SECRET: 'x',
      AWS_ACCESS_KEY_ID: 'x',
    });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/u', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AIKANBAN_CRED_PIPE).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });
});

describe('runCheckCommand', () => {
  test('records the tail, exit code and redacted log', async () => {
    const dir = makeTempDir('aikanban-check-run-');
    const log = path.join(dir, 'check.log');
    const result = await runCheckCommand({
      command: 'node -e "console.log(\'sk-abcdefghijklmnopqrstuvwxyz\')"',
      cwd: dir,
      timeoutMs: 10_000,
      logFile: log,
      redact: (text) => text.replace(/sk-[a-z]+/g, '[redacted]'),
    });

    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('[redacted]');
    expect(fs.readFileSync(log, 'utf8')).toBe('[redacted]');
  });

  test('reports unsupported commands without spawning a shell', async () => {
    const result = await runCheckCommand({ command: 'npm test && whoami', cwd: makeTempDir(), timeoutMs: 1_000 });
    expect(result.status).toBe('unsupported');
    expect(result.exitCode).toBeNull();
  });

  test('times out and kills the process tree', async () => {
    const result = await runCheckCommand({
      command: 'node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)"',
      cwd: makeTempDir(),
      timeoutMs: 250,
    });
    expect(result.status).toBe('timed_out');
    expect(result.error).toMatch(/Timed out/);
  });

  test('reports a non-zero exit as failed', async () => {
    const result = await runCheckCommand({
      command: 'node -e "process.exit(3)"',
      cwd: makeTempDir(),
      timeoutMs: 10_000,
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
  });
});

/** Long-lived check script: spawns a grandchild, publishes its pid next to itself, then idles. */
const TREE_SCRIPT = [
  "const cp = require('node:child_process');",
  "const fs = require('node:fs');",
  "const g = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)']);",
  "fs.writeFileSync('grandchild.pid', String(g.pid));",
  'setInterval(function () {}, 1000);',
].join(' ');

/** Resolves once `pid` no longer exists; throws after `timeoutMs` if it somehow survives. */
async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`Process ${pid} is still alive after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('runCheckCommand stop seam', () => {
  test('onSpawned exposes an idempotent killTree that kills the tree, grandchildren included', async () => {
    const dir = makeTempDir('aikanban-check-tree-');
    const pidFile = path.join(dir, 'grandchild.pid');
    const spawned: SpawnedCheckProcess[] = [];

    const pending = runCheckCommand({
      command: `node -e "${TREE_SCRIPT}"`,
      cwd: dir,
      timeoutMs: 20_000,
      onSpawned: (info) => {
        spawned.push(info);
      },
    });

    const deadline = Date.now() + 10_000;
    let grandchildPid = 0;
    while (Date.now() < deadline) {
      if (fs.existsSync(pidFile)) {
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          grandchildPid = parsed;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(grandchildPid).toBeGreaterThan(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.pid).toBeGreaterThan(0);

    // Idempotent: concurrent calls share one kill instead of racing taskkill.
    await Promise.all([spawned[0]!.killTree(), spawned[0]!.killTree()]);

    const result = await pending;
    expect(result.status).toBe('failed'); // killed via the seam, not passed and not timed_out
    await waitForProcessExit(grandchildPid);
  }, 30_000);

  test('killTree after the process exits naturally is a harmless no-op', async () => {
    const spawned: SpawnedCheckProcess[] = [];
    const result = await runCheckCommand({
      command: 'node -e "process.exit(0)"',
      cwd: makeTempDir(),
      timeoutMs: 10_000,
      onSpawned: (info) => {
        spawned.push(info);
      },
    });

    expect(result.status).toBe('passed');
    expect(spawned).toHaveLength(1);
    await expect(spawned[0]!.killTree()).resolves.toBeUndefined();
    await expect(spawned[0]!.killTree()).resolves.toBeUndefined();
  });
});
