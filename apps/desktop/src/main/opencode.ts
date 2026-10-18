// apps/desktop/src/main/opencode.ts — managed OpenCode install (spec §18.2).
// The app never uses the user's personal global OpenCode; it installs the pinned
// @opencode/cli into <dataDir>\runtime\opencode and verifies `--version` against the pin.
import { OPENCODE_PIN } from '@aik/contracts';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OpencodeInstallResult, OpencodeStatus } from '@aik/contracts';

export const opencodeRuntimeDir = (dataDir: string): string => path.join(dataDir, 'runtime', 'opencode');

export function opencodeExePath(dataDir: string): string {
  return path.join(opencodeRuntimeDir(dataDir), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
}

/** Advanced custom path (spec §18.2): AIK_OPENCODE_EXE overrides the managed location. */
function resolveExe(dataDir: string): string | null {
  const custom = process.env.AIK_OPENCODE_EXE;
  if (custom) return path.resolve(custom);
  const managed = opencodeExePath(dataDir);
  return fs.existsSync(managed) ? managed : null;
}

function runVersionProbe(exe: string): { ok: boolean; output: string } {
  const isScript = /\.(cmd|bat)$/i.test(exe);
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15_000, shell: isScript, windowsHide: true });
    if (r.error) return { ok: false, output: String(r.error) };
    return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

export function opencodeVersion(exe: string): string | null {
  const r = runVersionProbe(exe);
  if (!r.ok) return null;
  const m = /opencode v(\S+)/.exec(r.output);
  return m ? (m[1] as string) : null;
}

export function opencodeStatus(dataDir: string): OpencodeStatus {
  const exe = resolveExe(dataDir);
  const version = exe ? opencodeVersion(exe) : null;
  return { pinned: OPENCODE_PIN, exe, installed: version !== null, version, matchesPin: version === OPENCODE_PIN };
}

const run = (command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const kill = setTimeout(() => child.kill(), timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(kill);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}: ${stderr.slice(-400)}`));
    });
  });

/**
 * Installs the pinned OpenCode into <dataDir>\runtime\opencode using the package.json +
 * lockfile shipped with the app (dist\opencode-runtime). npm's allowScripts blocks the
 * package's own postinstall, so it is run explicitly (SPK-1 finding: it only hard-links
 * the binary from the locally installed platform package — no extra network access).
 */
export async function installOpencode(dataDir: string, assetsDir: string): Promise<OpencodeInstallResult> {
  const runtimeDir = opencodeRuntimeDir(dataDir);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.cpSync(path.join(assetsDir, file), path.join(runtimeDir, file));
    }
    await run('cmd.exe', ['/c', 'npm', 'ci', '--no-fund', '--no-audit'], runtimeDir, 10 * 60_000);
    const pkgDir = path.join(runtimeDir, 'node_modules', '@opencode', 'cli');
    await run('cmd.exe', ['/c', 'node', 'postinstall.mjs'], pkgDir, 60_000);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const version = opencodeVersion(opencodeExePath(dataDir));
  if (version === null) return { ok: false, error: 'Installed, but the binary did not report a version' };
  if (version !== OPENCODE_PIN) return { ok: false, error: `Installed ${version}, expected ${OPENCODE_PIN}` };
  return { ok: true, version };
}
