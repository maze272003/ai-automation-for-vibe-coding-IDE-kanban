// apps/orchestrator/src/checks/detect.ts
import type { CheckDetection, DetectedCheck } from '@aik/contracts';
import fs from 'node:fs';
import path from 'node:path';

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
}

function readJson(file: string): PackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

const exists = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

type NodePackageManager = 'npm' | 'pnpm' | 'yarn';

function nodePackageManager(repoPath: string, pkg: PackageJson): NodePackageManager {
  const declared = pkg.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  if (exists(repoPath, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(repoPath, 'yarn.lock')) return 'yarn';
  return 'npm';
}

function commandFor(pm: NodePackageManager, script: string): string {
  if (script === 'test') return pm === 'npm' ? 'npm test' : `${pm} test`;
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

function detectNode(repoPath: string): DetectedCheck[] {
  if (!exists(repoPath, 'package.json')) return [];
  const pkg = readJson(path.join(repoPath, 'package.json'));
  if (!pkg?.scripts) return [];
  const pm = nodePackageManager(repoPath, pkg);
  const found: DetectedCheck[] = [];
  for (const script of ['test', 'lint', 'typecheck'] as const) {
    if (!pkg.scripts[script]) continue;
    found.push({
      key: script,
      command: commandFor(pm, script),
      mandatory: true,
      timeoutSec: script === 'test' ? 900 : 300,
      source: `${pm} script "${script}"`,
    });
  }
  return found;
}

function detectPython(repoPath: string): DetectedCheck[] {
  const hasPyproject = exists(repoPath, 'pyproject.toml');
  const hasRequirements = exists(repoPath, 'requirements.txt');
  if (!hasPyproject && !hasRequirements) return [];

  if (hasPyproject && exists(repoPath, 'uv.lock')) {
    return [{ key: 'pytest', command: 'uv run pytest -q', mandatory: true, timeoutSec: 900, source: 'uv.lock' }];
  }
  if (hasPyproject && exists(repoPath, 'poetry.lock')) {
    return [{ key: 'pytest', command: 'poetry run pytest -q', mandatory: true, timeoutSec: 900, source: 'poetry.lock' }];
  }
  return [{
    key: 'pytest',
    command: 'python -m pytest -q',
    mandatory: true,
    timeoutSec: 900,
    source: hasPyproject ? 'pyproject.toml' : 'requirements.txt',
  }];
}

/**
 * Proposes checks from repository metadata (EXE-9). Nothing is persisted or executed here:
 * the human must confirm the proposal by saving the project settings.
 */
export function detectChecks(repoPath: string): CheckDetection {
  const ecosystems: string[] = [];
  const node = detectNode(repoPath);
  const python = detectPython(repoPath);
  if (node.length > 0) ecosystems.push('node');
  if (python.length > 0) ecosystems.push('python');

  const seen = new Set<string>();
  const unique = [...node, ...python].filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });

  const warnings: string[] = [];
  if (unique.length === 0) {
    warnings.push(
      'No checks were detected. Verification will need explicit acceptance of a secrets-only scan ' +
        '(secretsOnlyVerification) before an implementation can leave TESTING.',
    );
  }
  return { checks: unique, ecosystems, warnings };
}
