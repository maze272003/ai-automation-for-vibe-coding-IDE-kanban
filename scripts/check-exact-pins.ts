// Fails when any workspace manifest declares a dependency with a non-exact version.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export function findLooseRanges(manifest: Record<string, unknown>, file: string): string[] {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, string>)) {
      if (!EXACT.test(spec)) problems.push(`${file}: ${section}.${name} = "${spec}"`);
    }
  }
  return problems;
}

export function listManifests(root: string): string[] {
  const files = [path.join(root, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'package.json');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(import.meta.dirname, '..');
  const problems = listManifests(root).flatMap((file) =>
    findLooseRanges(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>, path.relative(root, file)),
  );
  if (problems.length > 0) {
    console.error(`Non-exact dependency versions found:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('All dependency versions are exact.');
}
