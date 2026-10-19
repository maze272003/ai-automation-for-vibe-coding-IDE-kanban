// apps/skill-vault/src/db.ts — SQLite metadata store (metadata only; skill bodies stay on disk).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const SKILL_STATUSES = [
  'discovered',
  'downloaded',
  'quarantined',
  'scanned',
  'approved',
  'rejected',
  'duplicate',
  'skipped',
  'failed',
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  repo_entry_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  repo_owner TEXT NOT NULL DEFAULT '',
  repo_name TEXT NOT NULL DEFAULT '',
  repo_url TEXT NOT NULL DEFAULT '',
  skill_path TEXT NOT NULL DEFAULT '',
  category TEXT,
  content_language TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  source_updated_at INTEGER,
  skill_url TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','downloaded','quarantined','scanned','approved','rejected','duplicate','skipped','failed')),
  content_sha256 TEXT,
  license TEXT,
  license_source TEXT,
  downloaded_at TEXT,
  download_commit TEXT,
  download_ref TEXT,
  dup_of_id TEXT,
  failure_reason TEXT,
  file_count INTEGER,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_repo ON skills(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_skills_hash ON skills(content_sha256);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (skill_id, path)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  file_path TEXT NOT NULL DEFAULT '',
  line INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_skill ON findings(skill_id);

CREATE TABLE IF NOT EXISTS finding_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  dismissed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  UNIQUE (finding_id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  high INTEGER NOT NULL DEFAULT 0,
  medium INTEGER NOT NULL DEFAULT 0,
  low INTEGER NOT NULL DEFAULT 0,
  info INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS download_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  params_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  upserts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  name TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','unapprove','unreject','rescan','download','auto')),
  actor TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_skill ON approvals(skill_id);

CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL CHECK (agent IN ('opencode','claude-code')),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project','global')),
  target_root TEXT NOT NULL,
  target_path TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  skill_hash TEXT,
  UNIQUE (agent, skill_id, scope, target_root)
);
`;

export class VaultDb {
  readonly db: Database.Database;
  /** True when FTS5 is available; search falls back to LIKE otherwise. */
  readonly ftsEnabled: boolean;

  private constructor(db: Database.Database, ftsEnabled: boolean) {
    this.db = db;
    this.ftsEnabled = ftsEnabled;
  }

  static open(sqlitePath: string): VaultDb {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = new Database(sqlitePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    let ftsEnabled = false;
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
          id UNINDEXED, name, description, search_text, category UNINDEXED
        );
      `);
      ftsEnabled = true;
    } catch {
      // FTS5 unavailable in this build — LIKE-based search is used instead.
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      throw new Error(`Unsupported vault schema version ${row.value} (expected ${SCHEMA_VERSION})`);
    }
    return new VaultDb(db, ftsEnabled);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export type SkillRow = {
  id: string;
  source: string;
  external_id: string | null;
  repo_entry_id: string | null;
  name: string;
  description: string;
  author: string;
  repo_owner: string;
  repo_name: string;
  repo_url: string;
  skill_path: string;
  category: string | null;
  content_language: string | null;
  stars: number;
  source_updated_at: number | null;
  skill_url: string;
  discovered_at: string;
  last_seen_at: string;
  status: SkillStatus;
  content_sha256: string | null;
  license: string | null;
  license_source: string | null;
  downloaded_at: string | null;
  download_commit: string | null;
  download_ref: string | null;
  dup_of_id: string | null;
  failure_reason: string | null;
  file_count: number | null;
  size_bytes: number | null;
};
