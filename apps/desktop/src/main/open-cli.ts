// apps/desktop/src/main/open-cli.ts — no-shell console launch for a story's CLI session
// (spec §6.3, §5.11). The renderer may only name a story: the session id and worktree come
// from the orchestrator over the authenticated bridge request and are re-validated here, so
// nothing renderer-supplied ever reaches spawn. argv only — never cmd.exe, never start,
// never sh -c.
import type { OpenCliResult, OpenCliTargetDTO } from '@aik/contracts';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { opencodeExePath } from './opencode.ts';

/** IPC payload of `aik:open-terminal-cli`. The legacy `{sessionId, cwd}` shape is rejected:
 *  the renderer no longer supplies the folder or the session id. */
export const OpenCliPayload = z.object({ storyId: z.number().int().positive() }).strict();
export type OpenCliPayload = z.infer<typeof OpenCliPayload>;

/** The orchestrator's response, re-validated before use (a malformed body never reaches spawn). */
const OpenCliTarget = z.union([
  z.object({ runtime: z.literal('opencode'), sessionRef: z.string().min(1).max(100), cwd: z.string().min(1).max(1000) }),
  z.object({ available: z.literal(false), reason: z.string().min(1).max(200) }),
]);

/** OpenCode session refs are opaque `ses_<base62>` tokens. The trailing lookahead is a real
 *  end-of-input anchor: a JS `$` also matches in front of a trailing newline, so `ses_x\n`
 *  would slip through `^…$` alone. */
const SESSION_REF = /^ses_[A-Za-z0-9]{1,64}(?![\s\S])/;

/** Script shims need a shell to run; they are refused, never fallen back to. */
const SCRIPT_EXTENSIONS = /\.(cmd|bat|ps1)$/i;

export interface OpenCliLaunchOptions {
  cwd: string;
  detached: true;
  stdio: 'ignore';
  shell: false;
  windowsHide: false;
}

export interface OpenCliLaunch {
  file: string;
  args: string[];
  options: OpenCliLaunchOptions;
}

export type OpenCliBuildResult = { ok: true; launch: OpenCliLaunch } | { ok: false; reason: string };

/** The child handle `openTerminalCli` needs: detaching plus a hook for the asynchronous
 *  spawn-failure event (a missing cwd or unresolvable exe is reported by Node only after
 *  spawn() has returned). */
export interface OpenCliChild {
  unref(): void;
  once(event: 'error', listener: () => void): unknown;
}

/** Everything `buildOpenCliCommand` uses besides the target itself. All of it is main-owned:
 *  the resolved exe and the allowed roots are never renderer input. */
export interface OpenCliContext {
  exe: string | null;
  allowedRoots: readonly string[];
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  /** Whether containment folds path case; defaults to on for win32 only (the deployment target). */
  caseInsensitive?: boolean;
}

export type OpenCliSpawn = (file: string, args: readonly string[], options: OpenCliLaunchOptions) => OpenCliChild;

/** Resolve device paths (`\\?\C:\…`, `\\?\UNC\server\…`) to their plain Win32 form so a
 *  realpathed cwd and root always compare in the same spelling. */
const stripDevicePrefix = (p: string): string =>
  p.startsWith('\\\\?\\UNC\\') ? `\\\\${p.slice(8)}` : p.startsWith('\\\\?\\') ? p.slice(4) : p;

const fold = (p: string): string => p.toLowerCase();

/** True when `candidate` (already realpathed) is `root` itself or inside it. `path.relative`
 *  containment rejects siblings like `<root>-evil` that a plain startsWith would accept, and
 *  anything that escapes with an exact `..` segment or lands on another drive — a child merely
 *  *named* `..foo` stays allowed. Windows `path.relative` also folds case internally, so the
 *  exact-case prefix check is what carries the caller's case policy in the case-sensitive mode. */
function isInside(root: string, candidate: string, caseInsensitive: boolean): boolean {
  const a = stripDevicePrefix(root);
  const b = stripDevicePrefix(candidate);
  // A root spelled with a trailing separator (`C:\`, `/`) must not double the separator in the
  // exact-case prefix check.
  const base = a.endsWith(path.sep) ? a.slice(0, -path.sep.length) : a;
  if (!caseInsensitive && b !== base && !b.startsWith(base + path.sep)) return false;
  const rel = path.relative(caseInsensitive ? fold(a) : a, caseInsensitive ? fold(b) : b);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function containedCwd(cwd: string, ctx: OpenCliContext): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!path.isAbsolute(cwd)) return { ok: false, reason: 'The session folder must be an absolute path' };
  const exists = ctx.exists ?? existsSync;
  const realpath = ctx.realpath ?? realpathSync.native;
  // Windows is the deployment target, and Node's realpath returns on-disk casing there, so
  // folding is on for win32 only; every other platform compares exactly.
  const caseInsensitive = ctx.caseInsensitive ?? process.platform === 'win32';
  if (!exists(cwd)) return { ok: false, reason: 'The session folder does not exist' };
  let real: string;
  try {
    real = stripDevicePrefix(realpath(cwd));
  } catch {
    return { ok: false, reason: 'The session folder cannot be resolved' };
  }
  for (const root of ctx.allowedRoots) {
    let realRoot: string;
    try {
      realRoot = realpath(root);
    } catch {
      continue; // a root that cannot be resolved validates nothing
    }
    if (isInside(realRoot, real, caseInsensitive)) return { ok: true, cwd: real };
  }
  return { ok: false, reason: 'The session folder is outside the allowed workspaces' };
}

/** Validates the target and returns the exact argv launch: `{file, args, options}` with
 *  `shell:false` and `windowsHide:false` (spec §6.3). The exe must be an absolute native
 *  executable — never a relative name or a `.cmd`/`.bat`/`.ps1` shim. */
export function buildOpenCliCommand(target: OpenCliTargetDTO, ctx: OpenCliContext): OpenCliBuildResult {
  if ('available' in target) return { ok: false, reason: target.reason };
  if (typeof target.sessionRef !== 'string' || !SESSION_REF.test(target.sessionRef)) {
    return { ok: false, reason: 'Invalid session reference' };
  }
  const cwd = containedCwd(target.cwd, ctx);
  if (!cwd.ok) return cwd;
  if (typeof ctx.exe !== 'string' || !path.isAbsolute(ctx.exe) || SCRIPT_EXTENSIONS.test(ctx.exe)) {
    return { ok: false, reason: 'OpenCode executable not found' };
  }
  return {
    ok: true,
    launch: {
      file: ctx.exe,
      args: ['--session', target.sessionRef],
      options: { cwd: cwd.cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false },
    },
  };
}

/** Resolves the OpenCode executable main may launch: the `AIK_OPENCODE_EXE` override, the
 *  managed install (`<dataDir>\runtime\opencode`, as `opencode.ts` lays it out), then the
 *  global npm layout. Only an existing regular file is returned, and on Windows it must be a
 *  native `.exe` — a `.cmd`/`.bat`/`.ps1` shim would need a shell, so it is refused, never
 *  fallen back to. */
export function resolveOpenCliExe(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidates: string[] = [];
  if (env.AIK_OPENCODE_EXE) candidates.push(path.resolve(env.AIK_OPENCODE_EXE));
  candidates.push(opencodeExePath(dataDir));
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || SCRIPT_EXTENSIONS.test(candidate)) continue;
    if (platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue; // missing or unreachable — try the next candidate
    }
    return candidate;
  }
  return null;
}

export interface OpenCliCall extends OpenCliContext {
  /** False when the IPC sender frame is not the trusted app origin: nothing is fetched or spawned. */
  trusted: boolean;
  payload: unknown;
  /** Authenticated orchestrator lookup of the story's target (`GET /stories/:id/open-cli-target`). */
  fetchTarget: (storyId: number) => Promise<unknown>;
  /** Lazy roots: resolved only after the payload validated and the target was fetched, so an
   *  untrusted sender or a bad payload causes zero orchestrator traffic. */
  resolveAllowedRoots?: () => Promise<readonly string[]>;
  spawn?: OpenCliSpawn;
  /** Late spawn failures (the 'error' event arrived after the result was returned) land here
   *  instead of becoming an uncaught exception in the main process. */
  onLaunchError?: (reason: string) => void;
}

/** The `aik:open-terminal-cli` flow: trust → strict payload → orchestrator lookup → validate →
 *  spawn argv-only. Every failure returns the same quiet shape; nothing is thrown across IPC. */
export async function openTerminalCli(call: OpenCliCall): Promise<OpenCliResult> {
  if (!call.trusted) return { ok: false, reason: 'unavailable' };
  const payload = OpenCliPayload.safeParse(call.payload);
  if (!payload.success) return { ok: false, reason: 'invalid request' };
  let raw: unknown;
  try {
    raw = await call.fetchTarget(payload.data.storyId);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (raw === null || raw === undefined) return { ok: false, reason: 'unavailable' };
  const target = OpenCliTarget.safeParse(raw);
  if (!target.success) return { ok: false, reason: 'unavailable' };
  let allowedRoots = call.allowedRoots;
  if (call.resolveAllowedRoots) {
    try {
      allowedRoots = await call.resolveAllowedRoots();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
  const build = buildOpenCliCommand(
    target.data,
    { exe: call.exe, allowedRoots, realpath: call.realpath, exists: call.exists, caseInsensitive: call.caseInsensitive },
  );
  if (!build.ok) return build;
  let child: OpenCliChild;
  try {
    child = (call.spawn ?? spawn)(build.launch.file, build.launch.args, build.launch.options);
  } catch {
    return { ok: false, reason: 'launch failed' };
  }
  // Async spawn failures (missing cwd, unresolvable exe, access denied) arrive as an 'error'
  // event only after spawn() returned. The listener is attached before unref() so the failure
  // is always captured: before we answer it becomes the error result, after that it is
  // surfaced through onLaunchError — never an uncaught exception in the main process.
  let failed = false;
  let answered = false;
  child.once('error', () => {
    failed = true;
    if (!answered) return;
    call.onLaunchError?.('launch failed');
  });
  child.unref();
  await new Promise<void>((resolve) => setImmediate(resolve));
  answered = true;
  return failed ? { ok: false, reason: 'launch failed' } : { ok: true };
}
