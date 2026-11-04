// apps/desktop/src/main/office-server.ts — the bundled Pixel Agents office server
// (spec 2026-11-04). Spawned privately with --no-terminal (a distinct access profile, so a
// user's own running instance is never silently reused). The registry entry the server writes
// (~/.pixel-agents/servers/<pid>-<port>.json, mode 0600) is the only trusted source of
// {port, token}; stdout is discarded because it prints the token.
import { PIXEL_AGENTS_PIN } from '@aik/contracts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OfficeServerInfo {
  port: number;
  url: string;
  token: string;
  pid: number | undefined;
}

export interface OfficeSpawnOptions {
  dataDir: string;
  assetsDir: string;
  /** Test seam: where registry entries are read from (default ~/.pixel-agents/servers). */
  registryDir?: string;
  /** Test seam: CLI to spawn (default: the runtime install's dist/cli.js). */
  command?: string;
  /** Test seam: node binary (default process.execPath). */
  node?: string;
  spawnTimeoutMs?: number;
}

export function officeInstallDir(dataDir: string): string {
  return path.join(dataDir, 'runtime', 'pixel-agents');
}

export function officeCliPath(dataDir: string): string {
  return path.join(officeInstallDir(dataDir), 'node_modules', 'pixel-agents', 'dist', 'cli.js');
}

export function officeInstalled(dataDir: string): boolean {
  return fs.existsSync(officeCliPath(dataDir));
}

/**
 * Best available node binary for the office CLI child. Prefers the system node on PATH —
 * the same node `installPixelAgents` needs for its `npm ci` — so the office keeps working
 * in a packaged build even if the repo's fuse policy (REL-6, runAsNode:false) is ever
 * wired into the release pipeline, since a fused exe ignores ELECTRON_RUN_AS_NODE.
 * Falls back to `process.execPath` (the Electron binary), which the ELECTRON_RUN_AS_NODE
 * env flag turns into a plain Node.
 */
export function resolveNodeBinary(): string {
  try {
    const hits = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = hits.find((s) => /^node(\.exe)?$/i.test(path.basename(s)) && fs.existsSync(s));
    if (hit) return hit;
  } catch {
    // node not on PATH — fall through to the Electron binary
  }
  return process.execPath;
}

/**
 * Env for the office CLI child. `ELECTRON_RUN_AS_NODE=1` is required whenever the spawn
 * binary is the Electron binary (dev electron.exe / packaged app exe): without it the
 * spawn is a second Electron app, the CLI never runs, and no agent character ever spawns
 * (the original no-pixel bug). A genuine node binary ignores the flag.
 */
export function officeSpawnEnv(registryDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...(registryDir ? { AIK_OFFICE_REGISTRY_DIR: registryDir } : {}),
  };
}

/** Installs/repairs the pinned runtime: npm ci inside the data dir (never the repo). */
export function installPixelAgents(dataDir: string, assetsDir: string): { ok: true; version: string } | { ok: false; error: string } {
  try {
    const installDir = officeInstallDir(dataDir);
    fs.mkdirSync(installDir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(assetsDir, file), path.join(installDir, file));
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['ci', '--no-fund', '--no-audit', '--ignore-scripts'], {
      cwd: installDir,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    const version = (
      JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', 'pixel-agents', 'package.json'), 'utf8')) as { version: string }
    ).version;
    if (version !== PIXEL_AGENTS_PIN) return { ok: false, error: `pixel-agents ${version} installed but ${PIXEL_AGENTS_PIN} pinned` };
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface RegistryEntry {
  port: number;
  pid: number;
  token: string;
}

function readRegistryEntry(registryDir: string, pid: number): RegistryEntry | null {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.startsWith(`${pid}-`)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf8')) as Partial<RegistryEntry>;
      if (typeof entry.port === 'number' && typeof entry.pid === 'number' && typeof entry.token === 'string') {
        return { port: entry.port, pid: entry.pid, token: entry.token };
      }
    } catch {
      // unparsable entry — keep scanning
    }
  }
  return null;
}

let current: { proc: ChildProcess; info: OfficeServerInfo } | null = null;
let starting: Promise<OfficeServerInfo | null> | null = null;
// Bumped by every stop (and every fresh start attempt): an in-flight launch that no
// longer matches the current generation was superseded, so its child is killed and
// never becomes `current` (a stop during startup must not "resurrect" the server).
let generation = 0;

export function startOfficeServer(opts: OfficeSpawnOptions): Promise<OfficeServerInfo | null> {
  if (current && current.proc.exitCode === null) return Promise.resolve(current.info);
  if (starting) return starting; // coalesced caller of the same in-flight attempt
  const gen = ++generation;
  starting = launch(opts).then((launched) => {
    starting = null;
    if (!launched) return null;
    if (gen !== generation) {
      launched.proc.kill(); // stopped/superseded while starting — never adopt it
      return null;
    }
    current = launched;
    return launched.info;
  });
  return starting;
}

async function launch(opts: OfficeSpawnOptions): Promise<{ proc: ChildProcess; info: OfficeServerInfo } | null> {
  const registryDir = opts.registryDir ?? path.join(os.homedir(), '.pixel-agents', 'servers');
  const command = opts.command ?? officeCliPath(opts.dataDir);
  const proc = spawn(opts.node ?? resolveNodeBinary(), [command, '--host', '127.0.0.1', '--no-terminal'], {
    stdio: 'ignore', // stdout prints the bearer token — never capture it
    env: officeSpawnEnv(opts.registryDir),
  });
  const timeoutMs = opts.spawnTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null;
    const entry = proc.pid ? readRegistryEntry(registryDir, proc.pid) : null;
    if (entry) {
      const url = `http://127.0.0.1:${entry.port}`;
      // Health-verify before declaring ready (their registry write precedes HTTP readiness).
      for (let i = 0; i < 40; i += 1) {
        try {
          const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            return { proc, info: { port: entry.port, url, token: entry.token, pid: proc.pid } };
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      proc.kill(); // registry entry but never healthy — don't orphan the CLI process
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  return null;
}

export function stopOfficeServer(): void {
  generation += 1; // invalidate any in-flight launch so it cannot adopt its child
  if (current) {
    current.proc.kill();
    current = null;
  }
}
