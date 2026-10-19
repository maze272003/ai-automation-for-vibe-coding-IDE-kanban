// apps/skill-vault/src/download.ts — bounded-concurrency, resumable download engine.
//
// Flow per repository: resolve pinned HEAD (ls-remote) → fetch codeload tarball →
// hardened extraction → expand every SKILL.md directory into a skill row → write
// immutable content + provenance into quarantined/ → dedupe by content hash.
// Catalog entries that expand into multiple skills are kept as provenance links.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VaultConfig } from './config.ts';
import type { VaultDb} from './db.ts';
import { type SkillRow } from './db.ts';
import type { PoliteHttpClient } from './http.ts';
import type { GithubResolver, RepoHead } from './github.ts';
import { codeloadTarballUrl, detectLicense } from './github.ts';
import type { Logger } from './log.ts';
import { skillContentDir, skillDirSlug, statusHome, type VaultPaths } from './paths.ts';
import { parseFrontmatter } from './scanner.ts';
import { extractTarGz } from './tar.ts';
import { nowIso, sha256Hex, writeFileAtomic } from './util.ts';

export type DownloadTargets =
  | { kind: 'coding' }
  | { kind: 'all-accessible' }
  | { kind: 'skills'; ids: string[] };

export type DownloadOptions = {
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
  resume?: boolean;
};

export type DownloadResult = {
  dryRun: boolean;
  reposConsidered: number;
  reposProcessed: number;
  skillsDownloaded: number;
  duplicates: number;
  skippedUnchanged: number;
  expandedEntries: number;
  failed: number;
  bytesFetched: number;
  diskGuardTriggered: boolean;
  failures: Array<{ repo: string; error: string }>;
  notes: string[];
};

const SKILL_MD = 'skill.md';

/** Group retained files into skill directories (every dir containing a SKILL.md). */
export const findSkillDirs = (files: Map<string, Buffer>): string[] => {
  const dirs = new Set<string>();
  for (const filePath of files.keys()) {
    const base = filePath.split('/').pop() ?? '';
    if (base.toLowerCase() === SKILL_MD) {
      const dir = path.posix.dirname(filePath);
      dirs.add(dir === '.' ? '' : dir);
    }
  }
  return [...dirs].sort();
};

const filesUnderDir = (files: Map<string, Buffer>, dir: string): Map<string, Buffer> => {
  const prefix = dir.length > 0 ? `${dir}/` : '';
  const out = new Map<string, Buffer>();
  for (const [filePath, data] of files) {
    if (dir === '' ? !filePath.includes('/') : filePath.startsWith(prefix)) {
      out.set(filePath, data);
    }
  }
  return out;
};

type QueueRow = SkillRow;

/** Select catalog rows for the requested target set. */
function selectQueue(db: VaultDb, targets: DownloadTargets, limit: number, resume: boolean): QueueRow[] {
  const statuses = resume ? ['discovered', 'failed'] : ['discovered'];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db.db
    .prepare(`SELECT * FROM skills WHERE status IN (${placeholders}) ORDER BY stars DESC, id ASC`)
    .all(...statuses) as SkillRow[];
  const filtered =
    targets.kind === 'coding'
      ? rows // discovery already filters to coding categories; every discovered row is in scope
      : targets.kind === 'skills'
        ? rows.filter((row) => targets.ids.includes(row.id) || targets.ids.includes(row.external_id ?? ''))
        : rows;
  return filtered.slice(0, limit);
}

export async function runDownload(
  ctx: {
    db: VaultDb;
    config: VaultConfig;
    paths: VaultPaths;
    http: PoliteHttpClient;
    github: Pick<GithubResolver, 'resolveHead' | 'repoMetadata'>;
    logger: Logger;
  },
  targets: DownloadTargets,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const { db, config, paths, http, github, logger } = ctx;
  const result: DownloadResult = {
    dryRun: opts.dryRun === true,
    reposConsidered: 0,
    reposProcessed: 0,
    skillsDownloaded: 0,
    duplicates: 0,
    skippedUnchanged: 0,
    expandedEntries: 0,
    failed: 0,
    bytesFetched: 0,
    diskGuardTriggered: false,
    failures: [],
    notes: [],
  };
  const dl = config.download;
  const concurrency = Math.min(opts.concurrency ?? dl.concurrency, 8);
  const limit = opts.limit ?? 500;

  const queue = selectQueue(db, targets, limit, opts.resume !== false);
  result.reposConsidered = queue.length;
  if (queue.length === 0) {
    result.notes.push('Nothing pending for the requested target (everything already processed).');
    return result;
  }

  // Group by repo; a repo is fetched once regardless of how many catalog rows point at it.
  const byRepo = new Map<string, QueueRow[]>();
  for (const row of queue) {
    if (row.repo_owner.length === 0 || row.repo_name.length === 0) {
      db.db
        .prepare('UPDATE skills SET status = ?, failure_reason = ? WHERE id = ?')
        .run('failed', 'no parseable GitHub repository URL', row.id);
      result.failed += 1;
      result.failures.push({ repo: row.id, error: 'no parseable GitHub repository URL' });
      continue;
    }
    const key = `${row.repo_owner.toLowerCase()}/${row.repo_name.toLowerCase()}`;
    const list = byRepo.get(key) ?? [];
    list.push(row);
    byRepo.set(key, list);
  }

  if (result.dryRun) {
    for (const [repo, rows] of byRepo) {
      result.notes.push(`would download https://github.com/${repo} (${rows.length} catalog entr${rows.length === 1 ? 'y' : 'ies'})`);
    }
    return result;
  }

  const repos = [...byRepo.entries()];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= repos.length) return;
      if (result.diskGuardTriggered) return;
      const [repoKey, rows] = repos[index]!;
      const [ownerRaw, repoNameRaw] = repoKey.split('/');
      const owner = ownerRaw!;
      const repoName = repoNameRaw!;

      try {
        // Disk-space safeguard before every fetch.
        const free = await freeDiskBytes(paths.root);
        if (free !== undefined && free < dl.minFreeDiskBytes) {
          result.diskGuardTriggered = true;
          result.notes.push(
            `disk guard triggered: ${free} bytes free at ${paths.root} (min ${dl.minFreeDiskBytes}); stopping early.`,
          );
          return;
        }
        await processRepo(
          { db, config, paths, http, github, logger },
          { owner, repo: repoName, catalogRows: rows },
          result,
        );
      } catch (error) {
        const message = (error as Error).message;
        result.failed += rows.length;
        for (const row of rows) {
          recordAttempt(db, row.id, 'error', 0, message);
          db.db
            .prepare('UPDATE skills SET status = ?, failure_reason = ? WHERE id = ? AND status = ?')
            .run('failed', message.slice(0, 500), row.id, 'discovered');
        }
        result.failures.push({ repo: repoKey, error: message });
        logger.warn('repo download failed', { repo: repoKey, error: message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, worker));

  // Cross-batch duplicate reconciliation: parallel workers can store identical content before
  // either sees the other's hash. Keep the first (deterministic id order) and mark the rest.
  const dupGroups = db.db
    .prepare(
      `SELECT id FROM skills WHERE content_sha256 IS NOT NULL AND status IN ('downloaded','quarantined','scanned','rejected')
       AND content_sha256 IN (
         SELECT content_sha256 FROM skills WHERE content_sha256 IS NOT NULL AND status IN ('downloaded','quarantined','scanned','rejected')
         GROUP BY content_sha256 HAVING COUNT(*) > 1
       ) ORDER BY content_sha256, id`,
    )
    .all() as Array<{ id: string }>;
  const keptByHash = new Map<string, string>();
  const markDup = db.db.prepare('UPDATE skills SET status = ?, dup_of_id = ? WHERE id = ?');
  for (const row of dupGroups) {
    const hash = (db.db.prepare('SELECT content_sha256 AS h FROM skills WHERE id = ?').get(row.id) as { h: string }).h;
    const kept = keptByHash.get(hash);
    if (kept === undefined) {
      keptByHash.set(hash, row.id);
    } else if (kept !== row.id) {
      markDup.run('duplicate', kept, row.id);
      result.skillsDownloaded = Math.max(0, result.skillsDownloaded - 1);
      result.duplicates += 1;
    }
  }

  db.db
    .prepare(
      `INSERT INTO checkpoints (name, state_json, updated_at) VALUES ('download-run', ?, ?)
       ON CONFLICT(name) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .run(
      JSON.stringify({
        finishedAt: nowIso(),
        reposProcessed: result.reposProcessed,
        skillsDownloaded: result.skillsDownloaded,
        duplicates: result.duplicates,
        failed: result.failed,
      }),
      nowIso(),
    );

  return result;
}

async function processRepo(
  ctx: {
    db: VaultDb;
    config: VaultConfig;
    paths: VaultPaths;
    http: PoliteHttpClient;
    github: Pick<GithubResolver, 'resolveHead' | 'repoMetadata'>;
    logger: Logger;
  },
  job: { owner: string; repo: string; catalogRows: SkillRow[] },
  result: DownloadResult,
): Promise<void> {
  const { db, config, paths, http, github, logger } = ctx;
  const dl = config.download;
  const startedAt = nowIso();

  const head: RepoHead = await github.resolveHead(job.owner, job.repo);

  // Repository-level short-circuit: if this repo is already vaulted at the resolved commit,
  // new catalog entries for it are provenance links — no need to fetch the tarball again.
  const pinnedChildren = (
    ctx.db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM skills WHERE repo_owner = ? AND repo_name = ? AND download_commit = ? AND status != 'failed'`,
      )
      .get(job.owner, job.repo, head.commit) as { n: number }
  ).n;
  if (pinnedChildren > 0) {
    for (const row of job.catalogRows.filter((entry) => entry.download_commit !== head.commit)) {
      recordAttempt(ctx.db, row.id, 'already-vaulted', 0, `repo already vaulted at ${head.commit.slice(0, 12)}`);
      ctx.db.db
        .prepare('UPDATE skills SET status = ?, failure_reason = ?, download_commit = ?, download_ref = ?, last_seen_at = ? WHERE id = ?')
        .run('skipped', `repo already vaulted at this commit (linked skills carry provenance)`, head.commit, head.branch, nowIso(), row.id);
      result.expandedEntries += 1;
    }
    result.reposProcessed += 1;
    return;
  }

  // Incremental sync: skip the fetch when every row is already pinned to this commit.
  const doneRows = job.catalogRows.filter(
    (row) => row.download_commit === head.commit && ['downloaded', 'quarantined', 'scanned', 'approved', 'duplicate'].includes(row.status),
  );
  if (doneRows.length === job.catalogRows.length) {
    result.skippedUnchanged += job.catalogRows.length;
    return;
  }

  const tarball = await http.getBuffer(
    codeloadTarballUrl(job.owner, job.repo, head.commit),
    dl.maxArchiveBytes,
  );
  result.bytesFetched += tarball.length;
  const archiveSha = sha256Hex(tarball);

  const extracted = await extractTarGz(tarball, {
    maxFileBytes: dl.maxFileBytes,
    maxArchiveBytes: dl.maxArchiveBytes,
    maxFiles: dl.maxFilesPerSkill * 20,
    maxRetainedBytes: dl.maxBytesPerSkill * 8,
  });

  const licenseFile = [...extracted.files.entries()].find(([p]) => /^licen[cs]e(\.|$)/i.test(p.split('/').pop() ?? ''));
  const licenseText = licenseFile ? licenseFile[1].toString('utf8') : '';
  const license = detectLicense(licenseText);
  const metadata = await github.repoMetadata(job.owner, job.repo);
  const finalLicense = metadata?.license ?? license;
  const licenseSource = metadata?.license ? 'github-api' : license ? 'license-file' : null;

  const skillDirs = findSkillDirs(extracted.files);
  if (skillDirs.length === 0) {
    for (const row of job.catalogRows) {
      recordAttempt(db, row.id, 'no-skill-md', tarball.length, 'repository contains no SKILL.md');
      db.db
        .prepare('UPDATE skills SET status = ?, failure_reason = ? WHERE id = ?')
        .run('failed', 'repository contains no SKILL.md', row.id);
      result.failures.push({ repo: `${job.owner}/${job.repo}`, error: 'repository contains no SKILL.md' });
    }
    result.failed += job.catalogRows.length;
    return;
  }

  if (skillDirs.length === 1) {
    // The catalog entry IS the skill.
    const dir = skillDirs[0]!;
    for (const row of job.catalogRows) {
      await materializeSkill(
        { db, paths, logger },
        {
          row,
          updateRow: true,
          owner: job.owner,
          repo: job.repo,
          head,
          dir,
          files: filesUnderDir(extracted.files, dir),
          archiveSha,
          tarballBytes: tarball.length,
          license: finalLicense,
          licenseSource,
          startedAt,
        },
        result,
      );
    }
  } else {
    // Expand: each SKILL.md becomes its own skill row; catalog rows become provenance links.
    for (const dir of skillDirs) {
      const entry = job.catalogRows[0]!;
      await materializeSkill(
        { db, paths, logger },
        {
          row: entry,
          updateRow: false,
          owner: job.owner,
          repo: job.repo,
          head,
          dir,
          files: filesUnderDir(extracted.files, dir),
          archiveSha,
          tarballBytes: tarball.length,
          license: finalLicense,
          licenseSource,
          startedAt,
        },
        result,
      );
    }
    for (const row of job.catalogRows) {
      db.db
        .prepare('UPDATE skills SET status = ?, failure_reason = ?, last_seen_at = ? WHERE id = ?')
        .run('skipped', `expanded into ${skillDirs.length} child skills (see repo_entry_id links)`, nowIso(), row.id);
      result.expandedEntries += 1;
    }
  }
  result.reposProcessed += 1;
}

async function materializeSkill(
  ctx: { db: VaultDb; paths: VaultPaths; logger: Logger },
  job: {
    row: SkillRow;
    updateRow: boolean;
    owner: string;
    repo: string;
    head: RepoHead;
    dir: string;
    files: Map<string, Buffer>;
    archiveSha: string;
    tarballBytes: number;
    license: string | null;
    licenseSource: string | null;
    startedAt: string;
  },
  result: DownloadResult,
): Promise<void> {
  const { db, paths } = ctx;
  const { row, owner, repo, head, dir } = job;
  const skillMd = job.files.get(dir.length > 0 ? `${dir}/SKILL.md` : 'SKILL.md');
  if (skillMd === undefined) {
    throw new Error(`SKILL.md missing in extracted set for ${owner}/${repo}/${dir}`);
  }
  const contentSha = sha256Hex(skillMd);
  const skillPath = dir.length > 0 ? dir : '.';
  // The skill's own frontmatter is authoritative for child rows; the catalog entry name
  // is only a fallback (it belongs to the repo-level SkillsMP entry).
  const frontmatter = parseFrontmatter(skillMd.toString('utf8'));
  const skillName =
    frontmatter.data.name && frontmatter.data.name.length > 0
      ? frontmatter.data.name
      : dir.length > 0
        ? path.posix.basename(dir)
        : row.name;
  const skillDescription =
    frontmatter.data.description && frontmatter.data.description.length > 0
      ? frontmatter.data.description
      : row.description;
  const id = job.updateRow ? row.id : githubChildId(db, owner, repo, skillPath, row.id);

  // Deduplicate by content hash against any previously kept copy (provenance preserved).
  const original = db.db
    .prepare(
      `SELECT id FROM skills WHERE content_sha256 = ? AND id != ? AND status IN ('downloaded','quarantined','scanned','approved','duplicate') LIMIT 1`,
    )
    .get(contentSha, id) as { id: string } | undefined;

  const home = statusHome(paths, 'quarantined');
  const destDir = skillContentDir(home, owner, repo, skillDirSlug(skillPath, row.name));
  await fsp.rm(destDir, { recursive: true, force: true });
  for (const [filePath, data] of job.files) {
    const target = path.join(destDir, filePath);
    if (!target.startsWith(destDir + path.sep) && path.resolve(target) !== path.resolve(destDir)) {
      throw new Error(`refusing to write outside skill dir: ${filePath}`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }

  const totalBytes = [...job.files.values()].reduce((sum, buffer) => sum + buffer.length, 0);
  const provenance = {
    vault_version: 1,
    skill_id: id,
    name: skillName,
    source: 'skillsmp',
    source_skill_url: row.skill_url,
    source_external_id: row.external_id,
    repo_entry_id: row.id,
    repo: {
      owner,
      name: repo,
      url: `https://github.com/${owner}/${repo}`,
      ref: head.branch,
      commit: head.commit,
      resolved_via: head.via,
      archive_sha256: job.archiveSha,
      tarball_bytes: job.tarballBytes,
    },
    downloaded_at: nowIso(),
    license: job.license,
    license_source: job.licenseSource,
    file_count: job.files.size,
    size_bytes: totalBytes,
    content_sha256: contentSha,
    scan: { status: 'pending' },
  };
  await writeFileAtomic(path.join(destDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

  const status = original ? 'duplicate' : 'downloaded';
  const now = nowIso();
  if (job.updateRow) {
    db.db
      .prepare(
        `UPDATE skills SET skill_path = ?, status = ?, content_sha256 = ?, license = ?, license_source = ?,
         downloaded_at = ?, download_commit = ?, download_ref = ?, dup_of_id = ?, failure_reason = NULL,
         file_count = ?, size_bytes = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(
        skillPath,
        status,
        contentSha,
        job.license,
        job.licenseSource,
        now,
        head.commit,
        head.branch,
        original?.id ?? null,
        job.files.size,
        totalBytes,
        now,
        row.id,
      );
    recordAttempt(db, row.id, 'ok', job.tarballBytes, null);
    recordFiles(db, row.id, job.files);
  } else {
    db.db
      .prepare(
        `INSERT INTO skills (id, source, external_id, repo_entry_id, name, description, author, repo_owner, repo_name,
          repo_url, skill_path, category, content_language, stars, skill_url, discovered_at, last_seen_at, status,
          content_sha256, license, license_source, downloaded_at, download_commit, download_ref, dup_of_id, file_count, size_bytes)
         VALUES (?, 'github', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           -- Never downgrade a reviewed status when the content is unchanged.
           status = CASE WHEN skills.content_sha256 = excluded.content_sha256
                          AND skills.status IN ('scanned','approved','rejected','quarantined','duplicate')
                        THEN skills.status ELSE excluded.status END,
           name = CASE WHEN skills.content_sha256 = excluded.content_sha256 THEN skills.name ELSE excluded.name END,
           description = CASE WHEN skills.content_sha256 = excluded.content_sha256 THEN skills.description ELSE excluded.description END,
           content_sha256 = excluded.content_sha256,
           license = COALESCE(excluded.license, skills.license),
           license_source = COALESCE(excluded.license_source, skills.license_source),
           downloaded_at = COALESCE(skills.downloaded_at, excluded.downloaded_at),
           download_commit = excluded.download_commit,
           download_ref = excluded.download_ref,
           dup_of_id = COALESCE(excluded.dup_of_id, skills.dup_of_id),
           file_count = excluded.file_count,
           size_bytes = excluded.size_bytes,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        id,
        row.id,
        skillName,
        skillDescription,
        row.author,
        owner,
        repo,
        row.repo_url,
        skillPath,
        row.category,
        row.content_language,
        row.stars,
        row.skill_url,
        now,
        now,
        status,
        contentSha,
        job.license,
        job.licenseSource,
        now,
        head.commit,
        head.branch,
        original?.id ?? null,
        job.files.size,
        totalBytes,
      );
    recordAttempt(db, id, 'ok', job.tarballBytes, null);
    recordFiles(db, id, job.files);
  }

  if (original) {
    result.duplicates += 1;
    ctx.logger.info('duplicate skill content', { id, dup_of: original.id });
  } else {
    result.skillsDownloaded += 1;
  }
}

const githubChildId = (db: VaultDb, owner: string, repo: string, skillPath: string, entryId: string): string => {
  void db;
  void entryId;
  return `gh:${owner.toLowerCase()}/${repo.toLowerCase()}/${skillPath}`;
};

const recordAttempt = (db: VaultDb, skillId: string, outcome: string, bytes: number, error: string | null): void => {
  db.db
    .prepare('INSERT INTO download_attempts (skill_id, started_at, finished_at, outcome, bytes, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(skillId, nowIso(), nowIso(), outcome, bytes, error);
};

const recordFiles = (db: VaultDb, skillId: string, files: Map<string, Buffer>): void => {
  const insert = db.db.prepare(
    'INSERT INTO skill_files (skill_id, path, sha256, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(skill_id, path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes',
  );
  db.transaction(() => {
    db.db.prepare('DELETE FROM skill_files WHERE skill_id = ?').run(skillId);
    for (const [filePath, data] of files) {
      insert.run(skillId, filePath, sha256Hex(data), data.length);
    }
  });
};

const freeDiskBytes = async (root: string): Promise<number | undefined> => {
  try {
    const stats = await fs.promises.statfs(root);
    return stats.bsize * stats.bavail;
  } catch {
    return undefined;
  }
};
