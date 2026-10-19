// apps/skill-vault/test/helpers/temp.ts — tests must never touch real repositories or the real vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = () => fs.realpathSync.native(os.tmpdir()).toLowerCase();

/** Throws unless `p` resolves inside the OS temp directory. */
export function assertInTemp(p: string): void {
  const real = fs.realpathSync.native(p).toLowerCase();
  if (!real.startsWith(tmpRoot() + path.sep)) throw new Error(`Refusing to operate outside the temp directory: ${real}`);
}

export function makeTempDir(prefix = 'skill-vault-test-'): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
