import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLooseRanges, listManifests } from '../check-exact-pins.ts';

describe('findLooseRanges', () => {
  it('accepts exact versions and prereleases', () => {
    expect(findLooseRanges({ dependencies: { a: '1.2.3', b: '2.0.0-rc.1' } }, 'p')).toEqual([]);
  });

  it('rejects ranges, tags and wildcards', () => {
    const found = findLooseRanges({ dependencies: { a: '^1.2.3', b: '~1.0.0', c: 'latest', d: '*', e: '>=1' } }, 'p');
    expect(found).toHaveLength(5);
  });

  it('checks dev and optional dependencies but not peers', () => {
    const found = findLooseRanges(
      { devDependencies: { a: '^1.0.0' }, optionalDependencies: { b: '1.x' }, peerDependencies: { c: '^1.0.0' } },
      'p',
    );
    expect(found).toEqual(['p: devDependencies.a = "^1.0.0"', 'p: optionalDependencies.b = "1.x"']);
  });
});

describe('listManifests', () => {
  it('finds the root, apps and packages manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-pins-'));
    for (const dir of ['apps/x', 'packages/y']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'package.json'), '{}');
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const rel = listManifests(root).map((f) => path.relative(root, f)).sort();
    expect(rel).toEqual([path.join('apps', 'x', 'package.json'), 'package.json', path.join('packages', 'y', 'package.json')].sort());
  });
});
