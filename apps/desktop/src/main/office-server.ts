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

export function startOfficeServer(opts: OfficeSpawnOptions): Promise<OfficeServerInfo | null> {
  if (current && current.proc.exitCode === null) return Promise.resolve(current.info);
  starting ??= launch(opts).then((launched) => {
    current = launched;
    starting = null;
    return launched?.info ?? null;
  });
  return starting;
}

async function launch(opts: OfficeSpawnOptions): Promise<{ proc: ChildProcess; info: OfficeServerInfo } | null> {
  const registryDir = opts.registryDir ?? path.join(os.homedir(), '.pixel-agents', 'servers');
  const command = opts.command ?? officeCliPath(opts.dataDir);
  const proc = spawn(opts.node ?? process.execPath, [command, '--host', '127.0.0.1', '--no-terminal'], {
    stdio: 'ignore', // stdout prints the bearer token — never capture it
    env: { ...process.env, ...(opts.registryDir ? { AIK_OFFICE_REGISTRY_DIR: opts.registryDir } : {}) },
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
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  return null;
}

export function stopOfficeServer(): void {
  if (current) {
    current.proc.kill();
    current = null;
  }
}
