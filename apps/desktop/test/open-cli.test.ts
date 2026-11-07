// apps/desktop/test/open-cli.test.ts — the no-shell open-in-CLI launch (spec §6.3, plan
// 6.1a-13). Every spawn is an injected spy: no process is ever started here, and every path
// lives under the OS temp directory. Electron and node:child_process are mocked so the real
// `aik:open-terminal-cli` handler in bridge.ts can be exercised without a renderer.
import type { OpenCliResult } from '@aik/contracts';
import type * as ChildProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../orchestrator/test/helpers/temp.ts';
import { registerBridge, type BridgeDeps } from '../src/main/bridge.ts';
import { buildOpenCliCommand, openTerminalCli, resolveOpenCliExe, type OpenCliCall, type OpenCliContext, type OpenCliLaunchOptions } from '../src/main/open-cli.ts';
import { opencodeExePath } from '../src/main/opencode.ts';
import { desktopPaths } from '../src/main/paths.ts';
import type { OrchestratorSupervisor } from '../src/main/supervisor.ts';

const { ipcHandlers, spawnMock } = vi.hoisted(() => ({
  ipcHandlers: [] as Array<{ channel: string; handler: (event: unknown, raw: unknown) => unknown }>,
  spawnMock: vi.fn(() => ({ unref: (): void => undefined, once: (): void => undefined })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown): void => { ipcHandlers.push({ channel, handler }); } },
  BrowserWindow: {},
  dialog: {},
  shell: {},
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: spawnMock };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EXE = 'C:\\app\\runtime\\opencode\\node_modules\\@opencode\\cli\\bin\\opencode.exe';

interface SpawnCall {
  file: string;
  args: string[];
  options: OpenCliLaunchOptions;
}

const makeSpawnSpy = () => {
  const calls: SpawnCall[] = [];
  let unrefs = 0;
  const spy = vi.fn((file: string, args: readonly string[], options: OpenCliLaunchOptions) => {
    calls.push({ file, args: [...args], options });
    return {
      unref: (): void => {
        unrefs += 1;
      },
      once: (): void => undefined,
    };
  });
  return { spy, calls, unrefCount: () => unrefs };
};

/** Fake child: records the call order (the 'error' listener must be attached before unref())
 *  and lets the test fire the error immediately or long after the promise resolved. */
const makeChildSpy = (emitOnRegister = false) => {
  const events: string[] = [];
  const errorListeners: Array<() => void> = [];
  const child = {
    unref: (): void => {
      events.push('unref');
    },
    once: (event: 'error', listener: () => void): void => {
      events.push(`once:${event}`);
      errorListeners.push(listener);
      if (emitOnRegister) {
        events.push('error');
        listener();
      }
    },
  };
  return {
    child,
    events,
    emitError: (): void => {
      events.push('error');
      for (const listener of [...errorListeners]) listener();
    },
  };
};

const makeWorkspace = () => {
  const root = makeTempDir('aik-open-cli-');
  const story = path.join(root, 'INV-1');
  fs.mkdirSync(story);
  return { root, story };
};

const target = (sessionRef: string, cwd: string) => ({ runtime: 'opencode' as const, sessionRef, cwd });

const launchOf = (sessionRef: string, cwd: string) => ({
  ok: true,
  launch: { file: EXE, args: ['--session', sessionRef], options: { cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false } },
});

describe('buildOpenCliCommand: session reference', () => {
  it('rejects shell metacharacters, traversal, whitespace and overlong refs', () => {
    const { root, story } = makeWorkspace();
    const ctx: OpenCliContext = { exe: EXE, allowedRoots: [root] };
    const hostile = [
      'x & calc',
      '"; rm -rf /',
      '$(id)',
      'ses_x & calc',
      'ses_a\rb',
      'ses_abc\ndef',
      'ses_abc\n',
      '..\\..',
      'ses_a b',
      'ses_-dash',
      `ses_${'a'.repeat(65)}`,
      '',
    ];
    for (const sessionRef of hostile) {
      expect(buildOpenCliCommand(target(sessionRef, story), ctx), sessionRef).toEqual({
        ok: false,
        reason: 'Invalid session reference',
      });
    }
  });

  it('accepts a well-formed ses_ ref of the maximum length', () => {
    const { root, story } = makeWorkspace();
    const sessionRef = `ses_${'a'.repeat(64)}`;
    expect(buildOpenCliCommand(target(sessionRef, story), { exe: EXE, allowedRoots: [root] })).toEqual(
      launchOf(sessionRef, fs.realpathSync.native(story)),
    );
  });
});

describe('buildOpenCliCommand: session folder', () => {
  it('rejects a relative path', () => {
    const { root } = makeWorkspace();
    const r = buildOpenCliCommand(target('ses_good1', path.join('wt', 'INV-1')), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'The session folder must be an absolute path' });
  });

  it('rejects a drive-relative path like C:evil', () => {
    const { root } = makeWorkspace();
    const r = buildOpenCliCommand(target('ses_good1', 'C:evil'), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'The session folder must be an absolute path' });
  });

  it('rejects a folder that does not exist', () => {
    const { root } = makeWorkspace();
    const r = buildOpenCliCommand(target('ses_good1', path.join(root, 'missing')), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'The session folder does not exist' });
  });

  it('rejects a sibling of the root that a plain startsWith check would accept', () => {
    const { root } = makeWorkspace();
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling);
    const r = buildOpenCliCommand(target('ses_good1', sibling), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'The session folder is outside the allowed workspaces' });
  });

  it('rejects a junction inside the root that points outside it', () => {
    const { root } = makeWorkspace();
    const outside = makeTempDir('aik-open-cli-out-');
    const leak = path.join(root, 'leak');
    fs.symlinkSync(outside, leak, process.platform === 'win32' ? 'junction' : 'dir');
    const r = buildOpenCliCommand(target('ses_good1', leak), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'The session folder is outside the allowed workspaces' });
  });

  it('rejects UNC and device paths that are not under an allowed root', () => {
    const { root } = makeWorkspace();
    const ctx: OpenCliContext = { exe: EXE, allowedRoots: [root] };
    expect(buildOpenCliCommand(target('ses_good1', '\\\\nonexistent-aik-host\\share\\dir'), ctx)).toEqual({
      ok: false,
      reason: 'The session folder does not exist',
    });
    expect(buildOpenCliCommand(target('ses_good1', `\\\\?\\${path.join(root, 'gone')}`), ctx)).toEqual({
      ok: false,
      reason: 'The session folder does not exist',
    });
  });

  it('accepts a device-prefix spelling of a folder inside the root', () => {
    const { root, story } = makeWorkspace();
    expect(
      buildOpenCliCommand(target('ses_good1', `\\\\?\\${story}`), {
        exe: EXE,
        allowedRoots: [root],
        // the native realpath keeps the \\?\ device prefix on Windows; the launch cwd must not
        realpath: (p) => (p.startsWith('\\\\?\\') ? p : `\\\\?\\${p}`),
        exists: () => true,
      }),
    ).toEqual(launchOf('ses_good1', story));
  });

  it('accepts the story folder and the worktrees root itself', () => {
    const { root, story } = makeWorkspace();
    const ctx: OpenCliContext = { exe: EXE, allowedRoots: [root] };
    expect(buildOpenCliCommand(target('ses_good1', story), ctx)).toEqual(launchOf('ses_good1', fs.realpathSync.native(story)));
    expect(buildOpenCliCommand(target('ses_good1', root), ctx)).toEqual(launchOf('ses_good1', fs.realpathSync.native(root)));
  });

  it('allows a child folder merely named ..foo', () => {
    const { root } = makeWorkspace();
    const dotdot = path.join(root, '..foo');
    fs.mkdirSync(dotdot);
    expect(buildOpenCliCommand(target('ses_good1', dotdot), { exe: EXE, allowedRoots: [root] })).toEqual(
      launchOf('ses_good1', fs.realpathSync.native(dotdot)),
    );
  });

  it('accepts a child of a root spelled with a trailing separator (case-sensitive mode)', () => {
    const { root, story } = makeWorkspace();
    expect(
      buildOpenCliCommand(target('ses_good1', story), {
        exe: EXE,
        allowedRoots: [`${root}${path.sep}`],
        realpath: (p) => p,
        exists: () => true,
        caseInsensitive: false,
      }),
    ).toEqual(launchOf('ses_good1', story));
  });

  it('compares paths case-insensitively or exactly, per the caller\'s setting', () => {
    const { root, story } = makeWorkspace();
    const folded = (caseInsensitive: boolean): OpenCliContext => ({
      exe: EXE,
      allowedRoots: [root.toLowerCase()],
      realpath: (p) => p,
      exists: () => true,
      caseInsensitive,
    });
    const exact = (caseInsensitive: boolean): OpenCliContext => ({
      exe: EXE,
      allowedRoots: [root],
      realpath: (p) => p,
      exists: () => true,
      caseInsensitive,
    });
    const upper = story.toUpperCase();

    expect(buildOpenCliCommand(target('ses_good1', upper), folded(true))).toEqual(launchOf('ses_good1', upper));
    expect(buildOpenCliCommand(target('ses_good1', upper), folded(false))).toEqual({
      ok: false,
      reason: 'The session folder is outside the allowed workspaces',
    });
    expect(buildOpenCliCommand(target('ses_good1', story), exact(false))).toEqual(launchOf('ses_good1', story));
    expect(buildOpenCliCommand(target('ses_good1', story), exact(true))).toEqual(launchOf('ses_good1', story));
  });
});

describe('buildOpenCliCommand: executable', () => {
  it('refuses a missing, relative or script-shim exe', () => {
    const { root, story } = makeWorkspace();
    for (const exe of [null, 'opencode.exe', 'C:\\npm\\opencode.cmd', 'C:\\npm\\opencode.bat', 'C:\\npm\\opencode.ps1']) {
      const r = buildOpenCliCommand(target('ses_good1', story), { exe, allowedRoots: [root] });
      expect(r, String(exe)).toEqual({ ok: false, reason: 'OpenCode executable not found' });
    }
  });
});

describe('buildOpenCliCommand: launch shape', () => {
  it('returns the exact argv launch with no shell and a visible console', () => {
    const { root, story } = makeWorkspace();
    const r = buildOpenCliCommand(target('ses_good1', story), { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual(launchOf('ses_good1', fs.realpathSync.native(story)));
  });

  it('passes an unavailable target reason through', () => {
    const { root } = makeWorkspace();
    const r = buildOpenCliCommand({ available: false, reason: 'No story worktree' }, { exe: EXE, allowedRoots: [root] });
    expect(r).toEqual({ ok: false, reason: 'No story worktree' });
  });
});

describe('openTerminalCli', () => {
  it('rejects the legacy payload shape and never asks the orchestrator', async () => {
    const { root, story } = makeWorkspace();
    const fetchTarget = vi.fn(async () => target('ses_good1', story));
    const spawnSpy = makeSpawnSpy();
    for (const payload of [
      { sessionId: 'ses_abc', cwd: story },
      { storyId: 7, sessionId: 'ses_abc', cwd: story },
      { storyId: '7' },
      { storyId: 0 },
      undefined,
    ]) {
      const r = await openTerminalCli({ trusted: true, payload, exe: EXE, allowedRoots: [root], fetchTarget, spawn: spawnSpy.spy });
      expect(r, JSON.stringify(payload)).toEqual({ ok: false, reason: 'invalid request' });
    }
    expect(fetchTarget).not.toHaveBeenCalled();
    expect(spawnSpy.calls).toEqual([]);
  });

  it('returns a silent error shape for an untrusted sender and executes nothing', async () => {
    const { root, story } = makeWorkspace();
    const fetchTarget = vi.fn(async () => target('ses_good1', story));
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: false,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget,
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetchTarget).not.toHaveBeenCalled();
    expect(spawnSpy.calls).toEqual([]);
  });

  it('launches the looked-up target and nothing else from the payload', async () => {
    const { root, story } = makeWorkspace();
    const fetchTarget = vi.fn(async () => target('ses_good1', story));
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget,
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: true });
    expect(fetchTarget).toHaveBeenCalledTimes(1);
    expect(fetchTarget).toHaveBeenCalledWith(7);
    expect(spawnSpy.calls).toEqual([
      {
        file: EXE,
        args: ['--session', 'ses_good1'],
        options: { cwd: fs.realpathSync.native(story), detached: true, stdio: 'ignore', shell: false, windowsHide: false },
      },
    ]);
    expect(spawnSpy.unrefCount()).toBe(1);
  });

  it('resolves allowed roots lazily, after the target was fetched', async () => {
    const { root, story } = makeWorkspace();
    const outside = makeTempDir('aik-open-cli-out-');
    const order: string[] = [];
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [outside], // must NOT be used: the lazy roots replace it
      fetchTarget: async () => {
        order.push('fetchTarget');
        return target('ses_good1', story);
      },
      resolveAllowedRoots: async () => {
        order.push('roots');
        return [root];
      },
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(['fetchTarget', 'roots']);
    expect(spawnSpy.calls).toEqual([
      {
        file: EXE,
        args: ['--session', 'ses_good1'],
        options: { cwd: fs.realpathSync.native(story), detached: true, stdio: 'ignore', shell: false, windowsHide: false },
      },
    ]);
  });

  it('never spawns for a hostile session ref coming back from the lookup', async () => {
    const { root, story } = makeWorkspace();
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('x & calc', story),
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: false, reason: 'Invalid session reference' });
    expect(spawnSpy.calls).toEqual([]);
  });

  it('never spawns for a session folder outside the allowed roots', async () => {
    const { root } = makeWorkspace();
    const outside = makeTempDir('aik-open-cli-out-');
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('ses_good1', outside),
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: false, reason: 'The session folder is outside the allowed workspaces' });
    expect(spawnSpy.calls).toEqual([]);
  });

  it('never spawns when the session folder does not exist', async () => {
    const { root } = makeWorkspace();
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('ses_good1', path.join(root, 'missing')),
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: false, reason: 'The session folder does not exist' });
    expect(spawnSpy.calls).toEqual([]);
  });

  it('passes an unavailable target through without spawning', async () => {
    const { root } = makeWorkspace();
    const spawnSpy = makeSpawnSpy();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => ({ available: false, reason: 'No OpenCode session for this story' }),
      spawn: spawnSpy.spy,
    });
    expect(r).toEqual({ ok: false, reason: 'No OpenCode session for this story' });
    expect(spawnSpy.calls).toEqual([]);
  });

  it('returns the quiet unavailable shape when the orchestrator is unreachable or malformed', async () => {
    const { root } = makeWorkspace();
    const spawnSpy = makeSpawnSpy();
    const base: Omit<OpenCliCall, 'fetchTarget'> = {
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      spawn: spawnSpy.spy,
    };
    expect(await openTerminalCli({ ...base, fetchTarget: async () => null })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await openTerminalCli({ ...base, fetchTarget: async () => { throw new Error('down'); } })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await openTerminalCli({ ...base, fetchTarget: async () => ({ runtime: 'opencode', sessionRef: 42, cwd: root }) })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(spawnSpy.calls).toEqual([]);
  });

  it('reports a failed launch without throwing across IPC', async () => {
    const { root, story } = makeWorkspace();
    const failing = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('ses_good1', story),
      spawn: failing,
    });
    expect(r).toEqual({ ok: false, reason: 'launch failed' });
  });

  it('captures a spawn error that fires before the answer, as the error result', async () => {
    const { root, story } = makeWorkspace();
    const fake = makeChildSpy(true);
    const onLaunchError = vi.fn();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('ses_good1', story),
      spawn: () => fake.child,
      onLaunchError,
    });
    expect(r).toEqual({ ok: false, reason: 'launch failed' });
    expect(onLaunchError).not.toHaveBeenCalled();
    expect(fake.events).toEqual(['once:error', 'error', 'unref']);
  });

  it('surfaces a late spawn error through onLaunchError instead of throwing', async () => {
    const { root, story } = makeWorkspace();
    const fake = makeChildSpy();
    const onLaunchError = vi.fn();
    const r = await openTerminalCli({
      trusted: true,
      payload: { storyId: 7 },
      exe: EXE,
      allowedRoots: [root],
      fetchTarget: async () => target('ses_good1', story),
      spawn: () => fake.child,
      onLaunchError,
    });
    expect(r).toEqual({ ok: true });
    expect(fake.events).toEqual(['once:error', 'unref']); // the listener exists before unref()
    fake.emitError(); // the async 'error' event, long after the IPC result was sent
    expect(fake.events).toEqual(['once:error', 'unref', 'error']);
    expect(onLaunchError).toHaveBeenCalledTimes(1);
    expect(onLaunchError).toHaveBeenCalledWith('launch failed');
  });
});

describe('resolveOpenCliExe', () => {
  const touch = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  };

  it('uses the AIK_OPENCODE_EXE override when it is a real executable', () => {
    const dataDir = makeTempDir('aik-open-cli-data-');
    const custom = path.join(dataDir, 'custom-opencode.exe');
    touch(custom);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: custom })).toEqual(custom);
  });

  it('refuses a script shim instead of falling back to a shell', () => {
    const dataDir = makeTempDir('aik-open-cli-data-');
    const shim = path.join(dataDir, 'opencode.cmd');
    touch(shim);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: shim })).toEqual(null);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: path.join(dataDir, 'missing.exe') })).toEqual(null);
  });

  it('accepts only a regular file, and on Windows only a native .exe', () => {
    const dataDir = makeTempDir('aik-open-cli-data-');
    const dir = makeTempDir('aik-open-cli-dir-');
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: dir }, 'win32')).toEqual(null);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: dir }, 'linux')).toEqual(null);
    const bin = path.join(dataDir, 'opencode.bin');
    touch(bin);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: bin }, 'win32')).toEqual(null);
    expect(resolveOpenCliExe(dataDir, { AIK_OPENCODE_EXE: bin }, 'linux')).toEqual(bin);
  });

  it('finds the managed install and then the global npm layout', () => {
    const dataDir = makeTempDir('aik-open-cli-data-');
    const managed = opencodeExePath(dataDir);
    touch(managed);
    expect(resolveOpenCliExe(dataDir, {})).toEqual(managed);

    const emptyDataDir = makeTempDir('aik-open-cli-data-');
    const appData = makeTempDir('aik-open-cli-appdata-');
    const global = path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    touch(global);
    expect(resolveOpenCliExe(emptyDataDir, { APPDATA: appData })).toEqual(global);
    expect(resolveOpenCliExe(emptyDataDir, {})).toEqual(null);
  });
});

describe('aik:open-terminal-cli IPC handler', () => {
  it('causes zero orchestrator fetches and zero spawns for an untrusted sender or a bad payload', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const dataDir = makeTempDir('aik-open-cli-app-');
    // This handler reads only `port` from the supervisor; the other registered IPC channels are never invoked.
    const supervisor = { port: 41299 } as unknown as OrchestratorSupervisor;
    const deps: BridgeDeps = {
      supervisor,
      token: 'h'.repeat(43),
      paths: desktopPaths(dataDir),
      opencodeAssetsDir: path.join(dataDir, 'assets'),
      isTrustedSender: (url: string) => url === 'app://ui/index.html',
    };
    registerBridge(deps);
    const entry = ipcHandlers.find((h) => h.channel === 'aik:open-terminal-cli');
    expect(entry).toBeDefined();
    if (!entry) return;

    const untrusted = (await entry.handler({ senderFrame: { url: 'https://evil.example/' } }, { storyId: 7 })) as OpenCliResult;
    expect(untrusted).toEqual({ ok: false, reason: 'unavailable' });

    const badPayload = (await entry.handler({ senderFrame: { url: 'app://ui/index.html' } }, { sessionId: 'ses_abc' })) as OpenCliResult;
    expect(badPayload).toEqual({ ok: false, reason: 'invalid request' });

    // Neither the target fetch nor the lazy /projects roots lookup may have happened.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
