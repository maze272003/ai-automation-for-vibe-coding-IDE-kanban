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

export function makeTempRepo(opts: { name?: string } = {}): string {
  const parent = makeTempDir('aikanban-test-repo-');
  const dir = path.join(parent, opts.name ?? 'repo');
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A bare "remote" whose default branch is `trunk`, plus a clone of it. */
export function makeTempRemoteAndClone(): { remote: string; clone: string } {
  const seed = makeTempRepo();
  gitIn(seed, 'branch', '-m', 'trunk');
  const remote = path.join(makeTempDir('aikanban-test-remote-'), 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const clone = path.join(makeTempDir('aikanban-test-clone-'), 'clone');
  execFileSync('git', ['clone', '-q', remote, clone]);
  return { remote, clone };
}
