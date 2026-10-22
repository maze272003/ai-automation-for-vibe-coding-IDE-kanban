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
    const child = execFile('git', args, { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, err, stderr));
      else resolve(stdout.trimEnd());
    });
    child.stdin?.end();
  });
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitCredentialServer } from './credential-server.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sharedCredentialServer: GitCredentialServer | null = null;

export async function getSharedCredentialServer(): Promise<GitCredentialServer> {
  if (!sharedCredentialServer) {
    sharedCredentialServer = new GitCredentialServer();
    await sharedCredentialServer.start();
  }
  return sharedCredentialServer;
}

export async function closeSharedCredentialServer(): Promise<void> {
  if (sharedCredentialServer) {
    await sharedCredentialServer.close();
    sharedCredentialServer = null;
  }
}

/** Runs git with credential helper configured over local named pipe (spec §13.4). */
export async function gitWithCredentials(
  args: string[],
  opts: { cwd: string; token: string; input?: string; expiryUtc?: string; timeoutMs?: number; credentialServer?: GitCredentialServer }
): Promise<string> {
  const server = opts.credentialServer ?? (await getSharedCredentialServer());
  const nonce = server.createNonce(opts.token, opts.expiryUtc);
  const helperPath = path.resolve(__dirname, 'credential-helper-bin.cjs');
  const helperCmd = `!"${process.execPath.replace(/\\/g, '/')}" "${helperPath.replace(/\\/g, '/')}"`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: helperCmd,
    AIKANBAN_CRED_PIPE: server.pipePath,
    AIKANBAN_CRED_NONCE: nonce,
  };

  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(args, err, stderr));
        else resolve(stdout.trimEnd());
      }
    );
    if (opts.input) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
}

