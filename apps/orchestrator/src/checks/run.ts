// apps/orchestrator/src/checks/run.ts
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type CommandStatus = 'passed' | 'failed' | 'timed_out' | 'error' | 'unsupported';

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  logFile?: string;
  tailLines?: number;
  redact?: (text: string) => string;
  /** Called once when the check process is spawned; exposes the tree-kill stop seam. */
  onSpawned?: (info: SpawnedCheckProcess) => void;
}

/** Handle onto a running check process, for callers that must be able to stop it (EXE-13). */
export interface SpawnedCheckProcess {
  pid: number;
  /**
   * Kills the spawned process tree (grandchildren included). Idempotent: concurrent and
   * repeated calls share one kill, and killing after the process exited is a no-op.
   */
  killTree: () => Promise<void>;
}

export interface RunCommandResult {
  status: CommandStatus;
  exitCode: number | null;
  output: string;
  error?: string;
}

export class UnsupportedCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCommandError';
  }
}

/** Shell metacharacters are refused: check commands are data, not a shell program (spec §17.1). */
const SHELL_META = /[&|<>^`$%!\r\n]/;

/** Splits a command into argv, honouring simple single/double quotes. */
export function parseCommand(command: string): { file: string; args: string[] } {
  if (SHELL_META.test(command)) {
    throw new UnsupportedCommandError('Shell operators, variables and expansion are not supported in check commands');
  }
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new UnsupportedCommandError('Unterminated quote in check command');
  if (started) tokens.push(current);
  const [file, ...args] = tokens;
  if (!file || file.length === 0) throw new UnsupportedCommandError('Empty check command');
  return { file, args };
}

/** Environment for check processes: no provider keys, GitHub tokens or credential-helper variables (spec §13.4, §18.3). */
export function checkEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (
      /^GITHUB/i.test(key) ||
      /^AIKANBAN_CRED_/i.test(key) ||
      /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|SECRET(?:_ACCESS_KEY)?|TOKEN|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(key)
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  return env;
}

const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

const quoteForCmd = (token: string) => (/\s/.test(token) ? `"${token.replace(/"/g, '""')}"` : token);

function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    // Resolves once taskkill has finished so callers can rely on the tree being gone.
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  return Promise.resolve();
}

function lastLines(text: string, lines: number): string {
  const split = text.split(/\r?\n/);
  return split.slice(Math.max(0, split.length - lines)).join('\n').trimEnd();
}

function run(command: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let parsed: { file: string; args: string[] };
    try {
      parsed = parseCommand(command);
    } catch (err) {
      resolve({ status: 'unsupported', exitCode: null, output: err instanceof Error ? err.message : String(err) });
      return;
    }

    const useCmd = process.platform === 'win32' && (WINDOWS_SHIMS.has(parsed.file.toLowerCase()) || /\.(cmd|bat)$/i.test(parsed.file));
    const isWindows = process.platform === 'win32';
    const file = useCmd ? (process.env.ComSpec ?? 'cmd.exe') : parsed.file;
    const args = useCmd
      ? ['/d', '/s', '/c', [parsed.file, ...parsed.args].map(quoteForCmd).join(' ')]
      : parsed.args;

    const tailLines = opts.tailLines ?? 200;
    const maxBytes = 8 * 1024 * 1024;
    let full = '';
    let tailText = '';
    let timedOut = false;
    let exited = false;
    let killPromise: Promise<void> | null = null;

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: checkEnvironment(),
      windowsHide: true,
      shell: false,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTree = (): Promise<void> => {
      if (exited) return Promise.resolve();
      killPromise ??= killProcessTree(child);
      return killPromise;
    };

    if (child.pid !== undefined && opts.onSpawned) {
      opts.onSpawned({ pid: child.pid, killTree });
    }

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (full.length < maxBytes) full += text.slice(0, maxBytes - full.length);
      tailText = lastLines(tailText ? `${tailText}\n${text}` : text, tailLines);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree();
    }, opts.timeoutMs);

    const finish = (status: CommandStatus, exitCode: number | null, error?: string) => {
      clearTimeout(timer);
      const redact = opts.redact ?? ((s: string) => s);
      const output = redact(tailText);
      if (opts.logFile) {
        try {
          fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
          fs.writeFileSync(opts.logFile, redact(full).trimEnd());
        } catch {
          // log persistence is best-effort; evidence still carries the tail
        }
      }
      resolve({ status, exitCode, output, ...(error ? { error: redact(error) } : {}) });
    };

    child.on('error', (err) => {
      exited = true;
      finish('error', null, err.message);
    });
    child.on('close', (code) => {
      exited = true;
      if (timedOut) finish('timed_out', code, `Timed out after ${opts.timeoutMs} ms`);
      else if (code === 0) finish('passed', code);
      else finish('failed', code);
    });
  });
}

export function runCheckCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  return run(opts.command, opts);
}
