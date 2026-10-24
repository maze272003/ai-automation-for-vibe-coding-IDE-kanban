// apps/orchestrator/test/helpers/temp.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = () => fs.realpathSync.native(os.tmpdir()).toLowerCase();

/** Throws unless `p` resolves inside the OS temp directory — tests must never touch real repositories. */
export function assertInTemp(p: string): void {
  const real = fs.realpathSync.native(p).toLowerCase();
  if (!real.startsWith(tmpRoot() + path.sep)) throw new Error(`Refusing to operate outside the temp directory: ${real}`);
}

export function makeTempDir(prefix = 'aikanban-test-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const gitIn = (cwd: string, ...args: string[]) => {
  assertInTemp(cwd);
  return execFileSync('git', ['-c', 'user.name=aik-test', '-c', 'user.email=aik-test@localhost', ...args], { cwd, encoding: 'utf8' }).trim();
};

export function makeTempRepo(opts: { name?: string; track?: (dir: string) => void } = {}): string {
  const parent = makeTempDir('aikanban-test-repo-');
  opts.track?.(parent);
  const dir = path.join(parent, opts.name ?? 'repo');
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A bare "remote" whose default branch is `trunk`, plus a clone of it. `track` (optional) receives
 *  every temp root created here (seed repo parent, remote parent, clone parent) for test cleanup. */
export function makeTempRemoteAndClone(track?: (dir: string) => void): { remote: string; clone: string } {
  const seed = makeTempRepo({ track });
  gitIn(seed, 'branch', '-m', 'trunk');
  const remoteRoot = makeTempDir('aikanban-test-remote-');
  track?.(remoteRoot);
  const remote = path.join(remoteRoot, 'remote.git');
  const cloneRoot = makeTempDir('aikanban-test-clone-');
  track?.(cloneRoot);
  const clone = path.join(cloneRoot, 'clone');
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  execFileSync('git', ['clone', '-q', remote, clone]);
  return { remote, clone };
}
