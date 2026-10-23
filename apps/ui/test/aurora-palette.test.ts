// apps/ui/test/aurora-palette.test.ts
//
// The Aurora redesign replaces every hard-coded zinc/indigo utility class with a
// semantic token. This is the mechanical gate for that: a single missed class
// deep inside the story modal is exactly the kind of thing that survives review.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Any mention of the pre-Aurora palette, in a class string or anywhere else. */
const LEGACY_PALETTE = /\b(?:zinc|indigo)-\d{2,3}\b/g;

/**
 * Surfaces owned by the in-flight GitHub/providers integration rather than by
 * this redesign. They are restyled in a follow-up pass so that the Aurora
 * rewrite never collides with work happening in that area.
 */
const FOLLOW_UP = [
  'components/github/',
  'components/settings/github-settings.tsx',
  'components/settings/providers-card.tsx',
];

describe('Aurora palette', () => {
  it('has no zinc-* or indigo-* utility classes left in the renderer', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).replaceAll('\\', '/');
      if (FOLLOW_UP.some((owned) => rel.startsWith(owned))) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(LEGACY_PALETTE)) {
        offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
