// apps/skill-vault/src/repo-inspect.ts — inspect a target repository to drive skill selection.
// Read-only: manifests, file extensions and agent config files. Never executes repo code.
import fsp from 'node:fs/promises';
import path from 'node:path';

export type RepoInspection = {
  root: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  agents: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  manifestSummary: Record<string, string[]>;
};

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.c': 'c',
  '.h': 'c', '.hpp': 'cpp', '.swift': 'swift', '.scala': 'scala', '.sh': 'shell',
  '.ps1': 'powershell', '.sql': 'sql', '.css': 'css', '.scss': 'css', '.html': 'html',
};

const FRAMEWORK_MARKERS: Record<string, string[]> = {
  react: ['react'],
  'react-native': ['react-native'],
  next: ['next'],
  vue: ['vue'],
  svelte: ['svelte'],
  angular: ['@angular/core'],
  vite: ['vite'],
  electron: ['electron'],
  express: ['express'],
  fastify: ['fastify'],
  nestjs: ['@nestjs/core'],
  tailwind: ['tailwindcss'],
  'node:test': [], // detected from scripts
  vitest: ['vitest'],
  jest: ['jest'],
  playwright: ['@playwright/test'],
  drizzle: ['drizzle-orm'],
  prisma: ['prisma'],
  typeorm: ['typeorm'],
  zod: ['zod'],
  trpc: ['@trpc/server'],
  graphql: ['graphql'],
  django: ['django'],
  flask: ['flask'],
  fastapi: ['fastapi'],
  'pytest': ['pytest'],
  pandas: ['pandas'],
  numpy: ['numpy'],
  torch: ['torch'],
  tensorflow: ['tensorflow'],
  sklearn: ['scikit-learn'],
  actix: ['actix-web'],
  axum: ['axum'],
  rocket: ['rocket'],
  warp: ['warp'],
  gin: ['gin-gonic'],
  fiber: ['gofiber/fiber'],
};

const readFileIfExists = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

const fileExists = async (filePath: string): Promise<boolean> =>
  fsp.stat(filePath).then((s) => s.isFile()).catch(() => false);

async function countLanguages(root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || visited > 4000) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.venv' || entry.name === 'target') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        visited += 1;
        const language = EXTENSION_LANGUAGE[path.extname(entry.name).toLowerCase()];
        if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
  };
  await walk(root, 0);
  return counts;
}

export async function inspectRepo(root: string): Promise<RepoInspection> {
  const languages = new Map<string, number>();
  const frameworks: string[] = [];
  const packageManagers: string[] = [];
  const manifestSummary: Record<string, string[]> = {};
  const testCommands: string[] = [];
  const buildCommands: string[] = [];
  const lintCommands: string[] = [];

  // package.json
  const packageJsonPath = path.join(root, 'package.json');
  if (await fileExists(packageJsonPath)) {
    packageManagers.push('npm');
    try {
      const pkg = JSON.parse((await readFileIfExists(packageJsonPath)) ?? '{}') as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        workspaces?: unknown;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [framework, markers] of Object.entries(FRAMEWORK_MARKERS)) {
        if (markers.some((marker) => deps[marker] !== undefined)) frameworks.push(framework);
      }
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (/^(test|e2e)$/.test(name)) testCommands.push(`npm run ${name} (${script})`);
        if (/^build/.test(name)) buildCommands.push(`npm run ${name} (${script})`);
        if (/^(lint|format|typecheck|check)/.test(name)) lintCommands.push(`npm run ${name} (${script})`);
      }
      manifestSummary['package.json'] = Object.keys(deps).slice(0, 40);
    } catch {
      manifestSummary['package.json'] = ['<unparseable>'];
    }
  }

  // Python
  const pyproject = path.join(root, 'pyproject.toml');
  const requirements = path.join(root, 'requirements.txt');
  const pyprojectText = await readFileIfExists(pyproject);
  if (pyprojectText !== undefined || (await fileExists(requirements))) {
    languages.set('python', (languages.get('python') ?? 0) + 50);
    const text = pyprojectText ?? (await readFileIfExists(requirements)) ?? '';
    for (const [framework, markers] of Object.entries(FRAMEWORK_MARKERS)) {
      if (markers.some((marker) => text.includes(marker))) frameworks.push(framework);
    }
    manifestSummary[pyprojectText !== undefined ? 'pyproject.toml' : 'requirements.txt'] = text
      .split('\n')
      .filter((line) => /^\s*[A-Za-z0-9_-]+\s*[:=]/.test(line))
      .slice(0, 40);
  }

  // Other manifests
  const simpleManifests: Array<[string, string]> = [
    ['go.mod', 'go'], ['Cargo.toml', 'rust'], ['pom.xml', 'java-maven'],
    ['build.gradle', 'java-gradle'], ['build.gradle.kts', 'kotlin-gradle'], ['Gemfile', 'ruby'],
    ['composer.json', 'php'], ['mix.exs', 'elixir'], ['deno.json', 'deno'],
  ];
  for (const [manifest, language] of simpleManifests) {
    if (await fileExists(path.join(root, manifest))) {
      languages.set(language, (languages.get(language) ?? 0) + 50);
    }
  }

  for (const [language, count] of await countLanguages(root)) {
    languages.set(language, (languages.get(language) ?? 0) + count);
  }

  const agents: string[] = [];
  if (await fileExists(path.join(root, 'AGENTS.md'))) agents.push('agents-md');
  if (await fileExists(path.join(root, 'CLAUDE.md'))) agents.push('claude-md');
  if (await fileExists(path.join(root, '.opencode'))) agents.push('opencode');
  if (await fileExists(path.join(root, '.claude'))) agents.push('claude-code');
  if (await fileExists(path.join(root, '.agents'))) agents.push('agents');

  const sortedLanguages = [...languages.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language);

  return {
    root,
    languages: sortedLanguages,
    frameworks: [...new Set(frameworks)],
    packageManagers: [...new Set(packageManagers)],
    agents,
    testCommands,
    buildCommands,
    lintCommands,
    manifestSummary,
  };
}

/** Turn an inspection into search terms for the vault. */
export function searchTermsForRepo(inspect: RepoInspection, task?: string): string[] {
  const terms = new Set<string>();
  for (const framework of inspect.frameworks) terms.add(framework);
  for (const language of inspect.languages.slice(0, 3)) terms.add(language);
  if (inspect.agents.length > 0) terms.add('agent');
  if (task !== undefined && task.trim().length > 0) {
    for (const token of task.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))) terms.add(token);
  }
  return [...terms].slice(0, 12);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'use', 'using',
  'make', 'better', 'new', 'existing', 'current', 'task', 'please', 'want', 'need', 'how', 'what',
]);
