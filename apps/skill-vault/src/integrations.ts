// apps/skill-vault/src/integrations.ts — OpenCode and Claude Code skill installation.
//
// Verified formats (2026-10-18):
//   OpenCode:    .opencode/skills/<name>/SKILL.md (project), ~/.config/opencode/skills/<name>/SKILL.md (global).
//                Frontmatter: name (required), description (required), license, compatibility, metadata.
//                name must match ^[a-z0-9]+(-[a-z0-9]+)*$ and the directory name; description ≤1024.
//   Claude Code: .claude/skills/<name>/SKILL.md (project), ~/.claude/skills/<name>/SKILL.md (personal).
//                Accepts the Agent Skills spec fields (name, description, license, compatibility,
//                metadata, allowed-tools) plus Claude-only extensions it ignores safely elsewhere.
//
// Safety: the vault only ever (a) copies approved skill directories into documented skills
// folders and (b) writes its own marker file. It never edits opencode.json / settings.json
// and never overwrites a directory it did not install.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import type { VaultDb} from './db.ts';
import { type SkillRow } from './db.ts';
import type { Logger } from './log.ts';
import { skillDirFor, type VaultPaths } from './paths.ts';
import { parseFrontmatter } from './scanner.ts';
import { copyDir, nowIso, readJsonIfExists, removeDir, sha256File, writeFileAtomic } from './util.ts';

const execFileAsync = promisify(execFile);

export type AgentId = 'opencode' | 'claude-code';

export type AgentSpec = {
  id: AgentId;
  command: string;
  projectSkillsDir: string;
  globalSkillsDir: string;
  docs: string;
};

export const AGENT_SPECS: Record<AgentId, AgentSpec> = {
  opencode: {
    id: 'opencode',
    command: 'opencode',
    projectSkillsDir: '.opencode/skills',
    globalSkillsDir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
    docs: 'https://opencode.ai/docs/skills/',
  },
  'claude-code': {
    id: 'claude-code',
    command: 'claude',
    projectSkillsDir: '.claude/skills',
    globalSkillsDir: path.join(os.homedir(), '.claude', 'skills'),
    docs: 'https://code.claude.com/docs/en/skills',
  },
};

export type AgentDetection = { agent: AgentId; installed: boolean; version: string | null };

export async function detectAgent(agent: AgentId): Promise<AgentDetection> {
  const spec = AGENT_SPECS[agent];
  const tryVersion = async (): Promise<string | undefined> => {
    // On Windows, npm shims are .cmd/.ps1 which execFile cannot launch directly.
    for (const useShell of [false, true]) {
      try {
        const { stdout } = useShell
          ? await execFileAsync(`${spec.command} --version`, { shell: true, timeout: 10_000, maxBuffer: 64 * 1024 })
          : await execFileAsync(spec.command, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024 });
        return stdout.trim().split('\n')[0]?.slice(0, 80);
      } catch {
        // try the next strategy
      }
    }
    return undefined;
  };
  const version = await tryVersion();
  return { agent, installed: version !== undefined, version: version ?? null };
}

const VALID_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type SkillValidation = {
  ok: boolean;
  installName: string;
  notes: string[];
};

export function validateSkillForAgent(agent: AgentId, skillMdText: string, fallbackName: string): SkillValidation {
  const notes: string[] = [];
  const { data } = parseFrontmatter(skillMdText);
  const name = (data.name ?? fallbackName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  if (data.name === undefined) notes.push('frontmatter "name" missing; derived from the skill name');
  if (data.description === undefined) notes.push('frontmatter "description" missing; agents may not auto-select this skill');
  if (data.description !== undefined && data.description.length > 1024) notes.push('description exceeds 1024 characters (OpenCode limit)');
  if (name.length > 64 || !VALID_NAME.test(name)) notes.push(`name "${name}" violates ^[a-z0-9]+(-[a-z0-9]+)*$ / 64 chars`);
  if (agent === 'opencode') {
    for (const key of Object.keys(data)) {
      if (!['name', 'description', 'license', 'compatibility', 'metadata'].includes(key)) {
        notes.push(`frontmatter field "${key}" is not part of the Agent Skills spec; OpenCode may ignore it`);
      }
    }
    if (data.metadata !== undefined && !/opencode\//.test(data.metadata)) {
      notes.push('no opencode/* metadata keys found; skill works but has no OpenCode-specific behavior');
    }
  }
  if (agent === 'claude-code') {
    for (const key of Object.keys(data)) {
      if (key === 'argument-hint' || key === 'disable-model-invocation' || key === 'when_to_use') {
        notes.push(`field "${key}" is Claude Code-specific and inert in other agents`);
      }
    }
  }
  return { ok: notes.length === 0, installName: name, notes };
}

const MARKER_FILE = 'skill-vault.json';

export type InstallOutcome =
  | { skillId: string; outcome: 'installed'; target: string; updated: boolean; notes: string[] }
  | { skillId: string; outcome: 'skipped'; reason: string; notes: string[] };

export type InstallReport = {
  agent: AgentId;
  scope: 'project' | 'global';
  targetRoot: string;
  dryRun: boolean;
  outcomes: InstallOutcome[];
  compatibility: Array<{ skillId: string; notes: string[] }>;
  discoverability: string[];
};

export function resolveTargetRoot(agent: AgentId, scope: 'project' | 'global', projectRoot?: string): string {
  if (scope === 'project') {
    if (projectRoot === undefined) throw new Error('Project scope requires --project <dir>');
    return path.resolve(projectRoot);
  }
  return AGENT_SPECS[agent].globalSkillsDir;
}

export async function installSkills(
  ctx: { db: VaultDb; paths: VaultPaths; logger: Logger },
  params: {
    agent: AgentId;
    scope: 'project' | 'global';
    targetRoot: string;
    skills: SkillRow[];
    dryRun?: boolean;
  },
): Promise<InstallReport> {
  const { db, paths } = ctx;
  const spec = AGENT_SPECS[params.agent];
  const skillsDir = params.scope === 'project' ? path.join(params.targetRoot, spec.projectSkillsDir) : params.targetRoot;
  const report: InstallReport = {
    agent: params.agent,
    scope: params.scope,
    targetRoot: params.targetRoot,
    dryRun: params.dryRun === true,
    outcomes: [],
    compatibility: [],
    discoverability: [],
  };

  for (const row of params.skills) {
    const sourceDir = skillDirFor(paths, row);
    // Downloaded content preserves repo-relative paths; the skill's own directory is skill_path.
    const skillSourceDir =
      row.skill_path.length > 0 && row.skill_path !== '.' ? path.join(sourceDir, ...row.skill_path.split('/')) : sourceDir;
    const skillMdPath = path.join(skillSourceDir, 'SKILL.md');
    let skillMdText: string;
    try {
      skillMdText = await fsp.readFile(skillMdPath, 'utf8');
    } catch {
      report.outcomes.push({ skillId: row.id, outcome: 'skipped', reason: 'SKILL.md not found in vault content', notes: [] });
      continue;
    }
    const validation = validateSkillForAgent(params.agent, skillMdText, row.name);
    report.compatibility.push({ skillId: row.id, notes: validation.notes });
    const targetDir = path.join(skillsDir, validation.installName);
    const existingMarker = await readJsonIfExists<{ skill_id?: string }>(path.join(targetDir, MARKER_FILE));

    if (existingMarker !== undefined) {
      if (existingMarker.skill_id !== row.id) {
        report.outcomes.push({
          skillId: row.id,
          outcome: 'skipped',
          reason: `target ${validation.installName} is managed for a different skill (${existingMarker.skill_id})`,
          notes: validation.notes,
        });
        continue;
      }
    } else {
      const targetExists = await fsp.stat(targetDir).then((s) => s.isDirectory()).catch(() => false);
      if (targetExists) {
        report.outcomes.push({
          skillId: row.id,
          outcome: 'skipped',
          reason: `target ${validation.installName} already exists and is not managed by this vault (refusing to overwrite)`,
          notes: validation.notes,
        });
        continue;
      }
    }

    if (report.dryRun) {
      report.outcomes.push({ skillId: row.id, outcome: 'installed', target: targetDir, updated: false, notes: validation.notes });
      continue;
    }

    await removeDir(targetDir);
    await copyDir(skillSourceDir, targetDir);
    const skillHash = await sha256File(path.join(targetDir, 'SKILL.md')).catch(() => null);
    await writeFileAtomic(
      path.join(targetDir, MARKER_FILE),
      `${JSON.stringify({ vault: '@aik/skill-vault', skill_id: row.id, source_hash: row.content_sha256, installed_at: nowIso() }, null, 2)}\n`,
    );
    db.db
      .prepare(
        `INSERT INTO integrations (agent, skill_id, scope, target_root, target_path, installed_at, skill_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent, skill_id, scope, target_root) DO UPDATE SET
           target_path = excluded.target_path, installed_at = excluded.installed_at, skill_hash = excluded.skill_hash`,
      )
      .run(params.agent, row.id, params.scope, params.targetRoot, targetDir, nowIso(), skillHash);
    report.outcomes.push({ skillId: row.id, outcome: 'installed', target: targetDir, updated: existingMarker !== undefined, notes: validation.notes });
  }

  report.discoverability.push(
    params.scope === 'project'
      ? `Skills install into ${path.join(spec.projectSkillsDir, '<name>', 'SKILL.md')}; ${spec.command} discovers them when run from ${params.targetRoot}.`
      : `Skills install into ${spec.globalSkillsDir}\\<name>\\SKILL.md; the agent loads them in every project.`,
  );
  report.discoverability.push(`Docs: ${spec.docs}`);
  return report;
}

export async function uninstallSkill(
  ctx: { db: VaultDb; logger: Logger },
  params: { skillId: string; agents?: AgentId[]; targetRoot?: string },
): Promise<Array<{ agent: AgentId; target: string; removed: boolean; reason?: string }>> {
  const { db } = ctx;
  const rows = (
    db.db
      .prepare(
        `SELECT i.agent, i.target_path FROM integrations i WHERE i.skill_id = ? ${
          params.agents ? `AND i.agent IN (${params.agents.map(() => '?').join(',')})` : ''
        } ${params.targetRoot ? 'AND i.target_root = ?' : ''}`,
      )
      .all(...([params.skillId, ...(params.agents ?? []), ...(params.targetRoot ? [params.targetRoot] : [])] as unknown[])) as Array<{
      agent: AgentId;
      target_path: string;
    }>
  );
  const results: Array<{ agent: AgentId; target: string; removed: boolean; reason?: string }> = [];
  for (const row of rows) {
    const marker = await readJsonIfExists<{ skill_id?: string }>(path.join(row.target_path, MARKER_FILE));
    if (marker?.skill_id !== params.skillId) {
      results.push({ agent: row.agent, target: row.target_path, removed: false, reason: 'marker missing or foreign; refusing to remove' });
      continue;
    }
    await removeDir(row.target_path);
    db.db.prepare('DELETE FROM integrations WHERE skill_id = ? AND target_path = ?').run(params.skillId, row.target_path);
    results.push({ agent: row.agent, target: row.target_path, removed: true });
  }
  if (rows.length === 0) {
    results.push({ agent: 'opencode', target: '', removed: false, reason: 'no vault-managed installation found for this skill' });
  }
  return results;
}

export const integrationStatus = (db: VaultDb): Array<{
  agent: string;
  skillId: string;
  scope: string;
  targetRoot: string;
  targetPath: string;
  installedAt: string;
}> =>
  db.db
    .prepare('SELECT agent, skill_id AS skillId, scope, target_root AS targetRoot, target_path AS targetPath, installed_at AS installedAt FROM integrations ORDER BY agent, installed_at')
    .all() as never;
