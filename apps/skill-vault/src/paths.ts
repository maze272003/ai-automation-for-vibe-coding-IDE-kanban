// apps/skill-vault/src/paths.ts — vault data-root resolution and directory layout.
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from './util.ts';

export type VaultPaths = {
  root: string;
  config: string;
  catalog: string;
  skillsJsonl: string;
  sourcesJson: string;
  syncStateJson: string;
  skillsQuarantined: string;
  skillsApproved: string;
  skillsRejected: string;
  indexes: string;
  sqlite: string;
  reports: string;
  logs: string;
  backups: string;
};

export const defaultVaultRoot = (): string => {
  const override = process.env.SKILL_VAULT_ROOT;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim().length > 0) {
    return path.join(localAppData, 'AiKanban', 'skill-vault');
  }
  return path.join(os.homedir(), '.ai-kanban', 'skill-vault');
};

export const resolveVaultRoot = (explicit?: string): string =>
  explicit && explicit.trim().length > 0 ? path.resolve(explicit.trim()) : defaultVaultRoot();

export function vaultPaths(root: string): VaultPaths {
  return {
    root,
    config: path.join(root, 'config'),
    catalog: path.join(root, 'catalog'),
    skillsJsonl: path.join(root, 'catalog', 'skills.jsonl'),
    sourcesJson: path.join(root, 'catalog', 'sources.json'),
    syncStateJson: path.join(root, 'catalog', 'sync-state.json'),
    skillsQuarantined: path.join(root, 'skills', 'quarantined'),
    skillsApproved: path.join(root, 'skills', 'approved'),
    skillsRejected: path.join(root, 'skills', 'rejected'),
    indexes: path.join(root, 'indexes'),
    sqlite: path.join(root, 'indexes', 'metadata.sqlite'),
    reports: path.join(root, 'reports'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
  };
}

/** Status → home directory inside the vault. */
export const statusHome = (paths: VaultPaths, status: string): string => {
  if (status === 'approved') return paths.skillsApproved;
  if (status === 'rejected') return paths.skillsRejected;
  // downloaded / quarantined / scanned / duplicate all live under quarantined until approved.
  return paths.skillsQuarantined;
};

export async function ensureVaultLayout(paths: VaultPaths): Promise<void> {
  for (const dir of [
    paths.config,
    paths.catalog,
    paths.skillsQuarantined,
    paths.skillsApproved,
    paths.skillsRejected,
    paths.indexes,
    paths.reports,
    paths.logs,
    paths.backups,
  ]) {
    await ensureDir(dir);
  }
}

/** Where a downloaded skill's immutable content lives. */
export const skillContentDir = (home: string, owner: string, repo: string, slug: string): string =>
  path.join(home, owner.toLowerCase(), repo.toLowerCase(), slug);

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';

/** Canonical on-disk directory name for a skill (must be used by download, scan, verify and integrate). */
export const skillDirSlug = (skillPath: string, name: string): string => {
  const normalized = skillPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0 || normalized === '.') return slugify(name);
  return normalized
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'))
    .join('__');
};

/** Resolve the on-disk content directory for a downloaded skill row, honoring its status home. */
export const skillDirFor = (paths: VaultPaths, row: { repo_owner: string; repo_name: string; skill_path: string; name: string; status: string }): string =>
  skillContentDir(statusHome(paths, row.status), row.repo_owner, row.repo_name, skillDirSlug(row.skill_path, row.name));
