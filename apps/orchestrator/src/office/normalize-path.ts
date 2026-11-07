import path from 'node:path';

/** Canonical form of a repo path for identity comparison: absolute, forward slashes, no trailing slash, case-folded on case-insensitive platforms. */
export function normalizeRepoPath(p: string, platform: NodeJS.Platform = process.platform): string {
  // Pick the resolver that matches the target platform so results do not depend on the host running the code.
  const resolved = platform === 'win32' ? path.win32.resolve(p) : path.posix.isAbsolute(p) ? path.posix.resolve(p) : path.resolve(p);
  let out = resolved.replace(/\\/g, '/');
  if (out.length > 1 && !/^[A-Za-z]:\/$/.test(out)) out = out.replace(/\/+$/, '');
  if (platform === 'win32' || platform === 'darwin') out = out.toLowerCase();
  return out;
}
