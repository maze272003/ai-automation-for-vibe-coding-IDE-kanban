// apps/skill-vault/src/backup.ts — vault backup (SQLite snapshot + catalog mirror) and restore.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VaultDb } from './db.ts';
import type { VaultPaths } from './paths.ts';
import { nowIso } from './util.ts';

const KEEP_BACKUPS = 5;

export type BackupResult = { sqlite: string; files: string[]; createdAt: string };

export async function backupVault(db: VaultDb, paths: VaultPaths): Promise<BackupResult> {
  const stamp = nowIso().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(paths.backups, stamp);
  await fsp.mkdir(dir, { recursive: true });
  const sqliteBackup = path.join(dir, 'metadata.sqlite');
  await db.db.backup(sqliteBackup);
  const copied: string[] = [];
  for (const file of [paths.skillsJsonl, paths.sourcesJson, paths.syncStateJson, path.join(paths.config, 'vault.config.json')]) {
    try {
      await fsp.copyFile(file, path.join(dir, path.basename(file)));
      copied.push(path.basename(file));
    } catch {
      // Optional files may not exist yet.
    }
  }
  // Prune old backups (keep newest KEEP_BACKUPS).
  const entries = (await fsp.readdir(paths.backups, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const old of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
    await fsp.rm(path.join(paths.backups, old), { recursive: true, force: true });
  }
  return { sqlite: sqliteBackup, files: copied, createdAt: nowIso() };
}

export type RestoreResult = { restored: boolean; message: string };

/** Restore a backup directory into the live vault. Requires confirm=true — it overwrites the DB. */
export async function restoreVault(
  paths: VaultPaths,
  backupDir: string,
  confirm: boolean,
): Promise<RestoreResult> {
  const backupDb = path.join(backupDir, 'metadata.sqlite');
  const exists = await fsp.stat(backupDb).then((s) => s.isFile()).catch(() => false);
  if (!exists) return { restored: false, message: `no metadata.sqlite in ${backupDir}` };
  if (!confirm) {
    return { restored: false, message: 'restore is destructive; pass --confirm to overwrite the current vault database' };
  }
  // WAL side files must go together with the main database file.
  await fsp.copyFile(backupDb, paths.sqlite);
  for (const suffix of ['-wal', '-shm']) {
    await fsp.rm(`${paths.sqlite}${suffix}`, { force: true }).catch(() => undefined);
  }
  for (const name of ['sources.json', 'sync-state.json', 'skills.jsonl', 'vault.config.json']) {
    const source = path.join(backupDir, name);
    const target =
      name === 'vault.config.json' ? path.join(paths.config, name) : name === 'skills.jsonl' ? paths.skillsJsonl : path.join(paths.catalog, name);
    if (name === 'vault.config.json') {
      await fsp.mkdir(paths.config, { recursive: true });
    }
    await fsp.copyFile(source, target).catch(() => undefined);
  }
  return { restored: true, message: `restored database from ${backupDir}` };
}
