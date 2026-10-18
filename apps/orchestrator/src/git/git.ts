// apps/orchestrator/src/git/git.ts
import { execFile } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], cause: unknown, stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}`, { cause });
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

/** Runs git with interactive prompts and credential helpers disabled (spec §13.4). */
export function git(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, err, stderr));
      else resolve(stdout.trimEnd());
    });
  });
}

export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
}
