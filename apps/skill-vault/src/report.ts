// apps/skill-vault/src/report.ts — vault status + download/integration reports.
import path from 'node:path';
import type { VaultDb } from './db.ts';
import type { VaultPaths } from './paths.ts';
import type { DownloadResult } from './download.ts';
import { dirSizeBytes, nowIso, writeFileAtomic } from './util.ts';
import type { InstallReport } from './integrations.ts';

export type VaultStatus = {
  generated_at: string;
  root: string;
  skillsByStatus: Record<string, number>;
  totalSkills: number;
  findingsBySeverity: Record<string, number>;
  installedIntegrations: number;
  diskUsageBytes: number;
  lastSync: { source: string; mode: string; status: string; finished_at: string; pages: number; upserts: number } | null;
  lastDownloadCheckpoint: unknown;
};

export async function collectStatus(db: VaultDb, paths: VaultPaths): Promise<VaultStatus> {
  const byStatus = (
    db.db.prepare('SELECT status, COUNT(*) AS n FROM skills GROUP BY status').all() as Array<{ status: string; n: number }>
  ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: row.n }), {});
  const total = (db.db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n;
  const bySeverity = (
    db.db
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM findings f LEFT JOIN finding_dismissals d ON d.finding_id = f.id
         WHERE d.id IS NULL GROUP BY severity`,
      )
      .all() as Array<{ severity: string; n: number }>
  ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.severity]: row.n }), {});
  const integrations = (db.db.prepare('SELECT COUNT(*) AS n FROM integrations').get() as { n: number }).n;
  const lastSync = db.db
    .prepare('SELECT source, mode, status, finished_at, pages, upserts FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get() as VaultStatus['lastSync'] ?? null;
  const lastDownloadCheckpoint = db.db
    .prepare("SELECT state_json FROM checkpoints WHERE name = 'download-run' ORDER BY updated_at DESC LIMIT 1")
    .get() as { state_json: string } | undefined;
  return {
    generated_at: nowIso(),
    root: paths.root,
    skillsByStatus: byStatus,
    totalSkills: total,
    findingsBySeverity: bySeverity,
    installedIntegrations: integrations,
    diskUsageBytes: await dirSizeBytes(paths.root),
    lastSync: lastSync ?? null,
    lastDownloadCheckpoint: lastDownloadCheckpoint ? JSON.parse(lastDownloadCheckpoint.state_json) : null,
  };
}

export async function writeDownloadReport(db: VaultDb, paths: VaultPaths, result: DownloadResult): Promise<string> {
  const status = await collectStatus(db, paths);
  const report = { generated_at: nowIso(), result, status };
  const out = path.join(paths.reports, 'download-report.json');
  await writeFileAtomic(out, `${JSON.stringify(report, null, 2)}\n`);
  return out;
}

export async function writeIntegrationReport(paths: VaultPaths, reports: InstallReport[]): Promise<string> {
  const out = path.join(paths.reports, 'integration-report.json');
  await writeFileAtomic(out, `${JSON.stringify({ generated_at: nowIso(), reports }, null, 2)}\n`);
  return out;
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
};
