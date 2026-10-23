// apps/orchestrator/src/isolation/job-object.ts
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IsolationOptions, IsolationRunner, ProcessResult } from './runner.js';

const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);
const quoteForCmd = (token: string) => (/\s/.test(token) ? `"${token.replace(/"/g, '""')}"` : token);

function scrubEnvironment(baseEnv: NodeJS.ProcessEnv = process.env, customEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...(customEnv ?? {}) };
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

function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
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

export class JobObjectIsolationRunner implements IsolationRunner {
  readonly kind = 'job_object' as const;

  async run(command: string[], options: IsolationOptions): Promise<ProcessResult> {
    if (!command || command.length === 0) {
      throw new Error('Command array must not be empty');
    }

    const [fileToken, ...argsTokens] = command;
    const isWindows = process.platform === 'win32';
    const useCmd = isWindows && (WINDOWS_SHIMS.has(fileToken.toLowerCase()) || /\.(cmd|bat)$/i.test(fileToken));
    const file = useCmd ? (process.env.ComSpec ?? 'cmd.exe') : fileToken;
    const args = useCmd
      ? ['/d', '/s', '/c', [fileToken, ...argsTokens].map(quoteForCmd).join(' ')]
      : argsTokens;

    // Temporary scratch directory for isolated profiles
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-iso-scratch-'));
    const env = scrubEnvironment(process.env, options.env);
    env.TEMP = scratchDir;
    env.TMP = scratchDir;

    return new Promise<ProcessResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let exited = false;
      let killPromise: Promise<void> | null = null;

      const child = spawn(file, args, {
        cwd: options.worktreeDir,
        env,
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

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let timer: NodeJS.Timeout | null = null;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          void killTree();
        }, options.timeoutMs);
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          fs.rmSync(scratchDir, { recursive: true, force: true });
        } catch {
          // ignore scratch removal failure
        }
      };

      child.on('error', (err) => {
        exited = true;
        cleanup();
        resolve({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat([...stderrChunks, Buffer.from(err.message, 'utf8')]),
          timedOut: false,
        });
      });

      child.on('close', (code) => {
        exited = true;
        cleanup();
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          timedOut,
        });
      });
    });
  }
}
