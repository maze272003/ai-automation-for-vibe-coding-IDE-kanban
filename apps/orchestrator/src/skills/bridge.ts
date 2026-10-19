import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  VaultDb,
  defaultVaultRoot,
  installSkills,
  type SkillRow,
  type VaultPaths,
  vaultPaths,
} from '@aik/skill-vault';

export type AgentRole = 'planner' | 'implementer' | 'reviewer';

export interface InjectSkillsInput {
  targetDirectory: string;
  role: AgentRole;
  storyTitle: string;
  storyDescription?: string;
  repoPath: string;
  isWorktree?: boolean;
}

export interface InjectedSkillSummary {
  id: string;
  name: string;
  installName: string;
}

export interface InjectSkillsResult {
  injected: InjectedSkillSummary[];
  promptHint: string;
}

const ROLE_DEFAULT_SKILLS: Record<AgentRole, string[]> = {
  planner: ['writing-plans'],
  implementer: ['tdd', 'systematic-debugging'],
  reviewer: ['code-review', 'requesting-code-review'],
};

export class SkillBridgeService {
  private readonly vaultRoot?: string;
  private readonly logger?: (msg: string) => void;

  constructor(deps: { vaultRoot?: string; logger?: (msg: string) => void } = {}) {
    this.vaultRoot = deps.vaultRoot;
    this.logger = deps.logger;
  }

  private resolvePaths(): VaultPaths | null {
    try {
      const root = this.vaultRoot ?? defaultVaultRoot();
      return vaultPaths(root);
    } catch {
      return null;
    }
  }

  private async ensureGitExclude(targetDir: string): Promise<void> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      let excludePath: string | null = null;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
          cwd: targetDir,
          encoding: 'utf8',
        });
        const resolved = stdout.trim();
        if (resolved) {
          excludePath = path.isAbsolute(resolved) ? resolved : path.resolve(targetDir, resolved);
        }
      } catch {
        // fallback to manual filesystem inspection
      }

      if (!excludePath) {
        const gitDir = path.join(targetDir, '.git');
        const gitStat = await fsp.stat(gitDir).catch(() => null);
        if (!gitStat) return;
        excludePath = gitStat.isDirectory() ? path.join(gitDir, 'info', 'exclude') : null;
      }

      if (!excludePath) return;

      await fsp.mkdir(path.dirname(excludePath), { recursive: true });
      const current = await fsp.readFile(excludePath, 'utf8').catch(() => '');
      if (!current.includes('.opencode/')) {
        await fsp.writeFile(excludePath, `${current ? current.trimEnd() + '\n' : ''}.opencode/\n`, 'utf8');
      }
    } catch (err) {
      this.logger?.(`Could not configure .git/info/exclude: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async injectSkills(input: InjectSkillsInput): Promise<InjectSkillsResult> {
    if (input.isWorktree) {
      await this.ensureGitExclude(input.targetDirectory);
    }

    const paths = this.resolvePaths();
    if (!paths) return { injected: [], promptHint: '' };

    const sqlitePath = paths.sqlite;
    const exists = await fsp.stat(sqlitePath).then(() => true).catch(() => false);
    if (!exists) return { injected: [], promptHint: '' };

    let db: VaultDb | null = null;
    try {
      db = VaultDb.open(sqlitePath);
      const wantedNames = ROLE_DEFAULT_SKILLS[input.role] ?? [];
      const placeholders = wantedNames.map(() => '?').join(',');
      const rows = wantedNames.length > 0
        ? (db.db.prepare(
            `SELECT * FROM skills WHERE status = 'approved' AND name IN (${placeholders}) LIMIT 3`,
          ).all(...wantedNames) as SkillRow[])
        : [];

      if (rows.length === 0) {
        return { injected: [], promptHint: '' };
      }

      const report = await installSkills(
        { db, paths, logger: { log: () => {} } as never },
        {
          agent: 'opencode',
          scope: 'project',
          targetRoot: input.targetDirectory,
          skills: rows,
          dryRun: false,
        },
      );

      const injected: InjectedSkillSummary[] = [];
      for (const outcome of report.outcomes) {
        if (outcome.outcome === 'installed') {
          const row = rows.find((r) => r.id === outcome.skillId);
          if (row) {
            injected.push({
              id: row.id,
              name: row.name,
              installName: path.basename(outcome.target),
            });
          }
        }
      }

      if (injected.length === 0) {
        return { injected: [], promptHint: '' };
      }

      const promptHint = [
        'AVAILABLE SKILLS (consult when applicable in .opencode/skills/):',
        ...injected.map((s) => `- ${s.installName}`),
      ].join('\n');

      return { injected, promptHint };
    } catch (err) {
      this.logger?.(`Skill injection failed: ${err instanceof Error ? err.message : String(err)}`);
      return { injected: [], promptHint: '' };
    } finally {
      db?.close();
    }
  }

  async cleanupSkills(targetDirectory: string): Promise<void> {
    try {
      const skillsDir = path.join(targetDirectory, '.opencode', 'skills');
      const entries = await fsp.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(skillsDir, entry.name);
        const markerPath = path.join(sub, 'skill-vault.json');
        const hasMarker = await fsp.stat(markerPath).then(() => true).catch(() => false);
        if (hasMarker) {
          await fsp.rm(sub, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // non-fatal cleanup
    }
  }
}
