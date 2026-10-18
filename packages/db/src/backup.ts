import fs from 'node:fs';
import path from 'node:path';

export const backupFileName = (d: Date): string => `app-${d.toISOString().replace(/[:.]/g, '-')}.db`;

export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^app-.*\.db$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function pruneBackups(dir: string, keep: number): void {
  const all = listBackups(dir);
  for (const file of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(file, { force: true });
}

/** Restores `backupFile` over `targetFile`. The current file (and WAL/SHM) is renamed aside, never deleted. */
export function restoreBackup(backupFile: string, targetFile: string): { movedAside: string | null } {
  let movedAside: string | null = null;
  if (fs.existsSync(targetFile)) {
    movedAside = `${targetFile}.corrupt-${Date.now()}`;
    fs.renameSync(targetFile, movedAside);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(targetFile + suffix)) fs.renameSync(targetFile + suffix, `${movedAside ?? targetFile}${suffix}.aside`);
  }
  fs.copyFileSync(backupFile, targetFile);
  return { movedAside };
}
