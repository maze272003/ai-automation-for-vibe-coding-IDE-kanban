// apps/orchestrator/src/verify/cleanroom.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IsolationRunner } from '../isolation/runner.ts';

const execFileAsync = promisify(execFile);

export interface CleanInstallResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CustomInstallRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<{ exitCode: number; stdout: Buffer | string; stderr: Buffer | string }>;

export interface CleanInstallOptions {
  runner?: CustomInstallRunner;
  isolationRunner?: IsolationRunner;
  timeoutMs?: number;
}

export function detectCleanInstallCommand(worktreePath: string): { cmd: string; args: string[] } | null {
  if (fs.existsSync(path.join(worktreePath, 'package-lock.json'))) {
    return { cmd: 'npm', args: ['ci'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) {
    return { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) {
    return { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'bun.lockb')) || fs.existsSync(path.join(worktreePath, 'bun.lock'))) {
    return { cmd: 'bun', args: ['install', '--frozen-lockfile'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'poetry.lock'))) {
    return { cmd: 'poetry', args: ['install', '--no-root'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'Pipfile.lock'))) {
    return { cmd: 'pipenv', args: ['sync'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'requirements.txt'))) {
    return { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'Cargo.lock'))) {
    return { cmd: 'cargo', args: ['check', '--locked'] };
  }
  if (fs.existsSync(path.join(worktreePath, 'go.sum'))) {
    return { cmd: 'go', args: ['mod', 'download'] };
  }
  return null;
}

export async function installCleanDependencies(
  worktreePath: string,
  opts?: CleanInstallOptions,
): Promise<CleanInstallResult> {
  const detected = detectCleanInstallCommand(worktreePath);
  if (!detected) {
    return {
      ok: true,
      command: 'none',
      stdout: 'No recognized lockfile found; clean dependency install skipped',
      stderr: '',
      exitCode: 0,
    };
  }

  const { cmd, args } = detected;
  const commandStr = `${cmd} ${args.join(' ')}`;
  const timeoutMs = opts?.timeoutMs ?? 300_000;

  if (opts?.runner) {
    try {
      const res = await opts.runner(cmd, args, { cwd: worktreePath, timeout: timeoutMs });
      const stdout = typeof res.stdout === 'string' ? res.stdout : res.stdout.toString('utf8');
      const stderr = typeof res.stderr === 'string' ? res.stderr : res.stderr.toString('utf8');
      return {
        ok: res.exitCode === 0,
        command: commandStr,
        stdout,
        stderr,
        exitCode: res.exitCode,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        command: commandStr,
        stdout: '',
        stderr: message,
        exitCode: 1,
      };
    }
  }

  if (opts?.isolationRunner) {
    try {
      const res = await opts.isolationRunner.run([cmd, ...args], {
        worktreeDir: worktreePath,
        timeoutMs,
      });
      return {
        ok: res.exitCode === 0,
        command: commandStr,
        stdout: res.stdout.toString('utf8'),
        stderr: res.stderr.toString('utf8'),
        exitCode: res.exitCode,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        command: commandStr,
        stdout: '',
        stderr: message,
        exitCode: 1,
      };
    }
  }

  try {
    const isWindows = process.platform === 'win32';
    const binary = isWindows && (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') ? `${cmd}.cmd` : cmd;
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: worktreePath,
      timeout: timeoutMs,
      encoding: 'utf8',
      shell: isWindows,
    });
    return {
      ok: true,
      command: commandStr,
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (err: unknown) {
    const errorObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
    const stdout = typeof errorObj?.stdout === 'string' ? errorObj.stdout : '';
    const stderr = typeof errorObj?.stderr === 'string' ? errorObj.stderr : (err instanceof Error ? err.message : String(err));
    const exitCode = typeof errorObj?.code === 'number' ? errorObj.code : 1;
    return {
      ok: false,
      command: commandStr,
      stdout,
      stderr,
      exitCode,
    };
  }
}
