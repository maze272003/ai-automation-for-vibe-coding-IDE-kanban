import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  VaultDb,
  defaultVaultRoot,
  installSkills,
  recommendForRepo,
  skillDirFor,
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

export interface DeliveredSkill {
  id: string;
  name: string;
  contentSha256: string;
  bytes: number;
}

export interface InjectSkillsResult {
  injected: InjectedSkillSummary[];
  delivered: DeliveredSkill[];
  promptHint: string;
}

export const ROLE_DEFAULT_SKILLS: Record<AgentRole, string[]> = {
  planner: ['writing-plans'],
  implementer: ['tdd', 'systematic-debugging'],
  reviewer: ['code-review', 'requesting-code-review'],
};

const MAX_DELIVERED_SKILLS = 3;
const SKILL_BODY_BUDGET_BYTES = 12_288;

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

  private async selectSkills(db: VaultDb, input: InjectSkillsInput): Promise<SkillRow[]> {
    const wantedNames = ROLE_DEFAULT_SKILLS[input.role] ?? [];
    const placeholders = wantedNames.map(() => '?').join(',');
    const defaults = wantedNames.length > 0
      ? (db.db.prepare(
          `SELECT * FROM skills WHERE status = 'approved' AND name IN (${placeholders}) LIMIT 3`,
        ).all(...wantedNames) as SkillRow[])
      : [];

    const { recommendations } = await recommendForRepo(db, {
      repoRoot: input.repoPath,
      task: `${input.storyTitle}\n${input.storyDescription ?? ''}`,
      limit: 5,
      statuses: ['approved'],
    });

    const byId = new Map<string, SkillRow>();
    for (const row of defaults) byId.set(row.id, row);
    for (const { skill } of [...recommendations].sort((a, b) => b.score - a.score)) {
      if (byId.size >= MAX_DELIVERED_SKILLS) break;
      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    }
    return [...byId.values()].slice(0, MAX_DELIVERED_SKILLS);
  }

  private async readDeliveredBodies(
    paths: VaultPaths,
    selected: SkillRow[],
  ): Promise<Array<DeliveredSkill & { body: string }>> {
    const delivered: Array<DeliveredSkill & { body: string }> = [];
    let remaining = SKILL_BODY_BUDGET_BYTES;
    for (const row of selected) {
      let body: string;
      try {
        body = await fsp.readFile(path.join(skillDirFor(paths, row), 'SKILL.md'), 'utf8');
      } catch (err) {
        this.logger?.(`Skill ${row.name} not deliverable: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > remaining) {
        this.logger?.(`Skill ${row.name} skipped: ${bytes} bytes do not fit the remaining ${remaining}-byte delivery budget`);
        continue;
      }
      remaining -= bytes;
      delivered.push({
        id: row.id,
        name: row.name,
        contentSha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bytes,
        body,
      });
    }
    return delivered;
  }

  async injectSkills(input: InjectSkillsInput): Promise<InjectSkillsResult> {
    if (input.isWorktree) {
      await this.ensureGitExclude(input.targetDirectory);
    }

    const paths = this.resolvePaths();
    if (!paths) return { injected: [], delivered: [], promptHint: '' };

    const sqlitePath = paths.sqlite;
    const exists = await fsp.stat(sqlitePath).then(() => true).catch(() => false);
    if (!exists) return { injected: [], delivered: [], promptHint: '' };

    let db: VaultDb | null = null;
    try {
      db = VaultDb.open(sqlitePath);
      const selected = await this.selectSkills(db, input);
      if (selected.length === 0) {
        return { injected: [], delivered: [], promptHint: '' };
      }

      const report = await installSkills(
        { db, paths, logger: { log: () => {} } as never },
        {
          agent: 'opencode',
          scope: 'project',
          targetRoot: input.targetDirectory,
          skills: selected,
          dryRun: false,
        },
      );

      const injected: InjectedSkillSummary[] = [];
      for (const outcome of report.outcomes) {
        if (outcome.outcome === 'installed') {
          const row = selected.find((r) => r.id === outcome.skillId);
          if (row) {
            injected.push({
              id: row.id,
              name: row.name,
              installName: path.basename(outcome.target),
            });
          }
        }
      }

      const deliveredWithBodies = await this.readDeliveredBodies(paths, selected);
      const delivered: DeliveredSkill[] = deliveredWithBodies.map((s) => ({
        id: s.id,
        name: s.name,
        contentSha256: s.contentSha256,
        bytes: s.bytes,
      }));

      const promptHint = deliveredWithBodies.length === 0
        ? ''
        : [
            'SKILLS — follow these when they apply to the task:',
            ...deliveredWithBodies.flatMap((s) => [`=== SKILL: ${s.name} ===`, s.body, '=== END SKILL ===']),
          ].join('\n');

      return { injected, delivered, promptHint };
    } catch (err) {
      this.logger?.(`Skill injection failed: ${err instanceof Error ? err.message : String(err)}`);
      return { injected: [], delivered: [], promptHint: '' };
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
