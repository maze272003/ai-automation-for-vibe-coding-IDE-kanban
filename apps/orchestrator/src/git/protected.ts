// apps/orchestrator/src/git/protected.ts
/**
 * Matches repository-relative paths against the simple glob syntax used by project settings:
 * `**` spans directories, `*` and `?` never cross a `/`. This is intentionally small: protected
 * paths are flags for the merge UI, not a security boundary.
 */
export function matchesGlob(file: string, glob: string): boolean {
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === undefined) break;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i += 1;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      continue;
    }
    regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex).test(file.replace(/\\/g, '/'));
}

/** Returns the changed paths that match any protected glob (spec §13.3 step 7). */
export function findProtectedPaths(paths: readonly string[], globs: readonly string[]): string[] {
  const flagged = new Set<string>();
  for (const file of paths) {
    if (globs.some((glob) => matchesGlob(file, glob))) flagged.add(file.replace(/\\/g, '/'));
  }
  return [...flagged].sort();
}
