import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import fs from 'node:fs';
import path from 'node:path';
import { backupFileName, pruneBackups } from './backup.ts';
import * as schema from './schema.ts';

export type AikSchema = typeof schema;
export type AikDb = BetterSQLite3Database<AikSchema>;
export type AikTx = Parameters<Parameters<AikDb['transaction']>[0]>[0];
/** Accepts either the database or a transaction (both extend the base class). */
export type AikDbOrTx = BaseSQLiteDatabase<'sync', Database.RunResult, AikSchema>;

export class DatabaseCorruptError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(`The database file is corrupt or is not a database: ${file}`, { cause });
    this.name = 'DatabaseCorruptError';
    this.file = file;
  }
}

export interface OpenDatabaseOptions {
  file: string;
  backupsDir: string;
  migrationsFolder: string;
  keepBackups?: number;
  now?: () => Date;
}

export interface OpenedDatabase {
  db: AikDb;
  sqlite: Database.Database;
  backupFile: string | null;
  close(): void;
}

function openChecked(file: string, existed: boolean): Database.Database {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(file);
    if (existed) {
      const result = sqlite.pragma('quick_check', { simple: true });
      if (result !== 'ok') throw new Error(`quick_check: ${String(result)}`);
    }
    return sqlite;
  } catch (err) {
    sqlite?.close();
    throw new DatabaseCorruptError(file, err);
  }
}

export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  const existed = fs.existsSync(opts.file) && fs.statSync(opts.file).size > 0;
  const sqlite = openChecked(opts.file, existed);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  let backupFile: string | null = null;
  if (existed) {
    fs.mkdirSync(opts.backupsDir, { recursive: true });
    backupFile = path.join(opts.backupsDir, backupFileName(opts.now?.() ?? new Date()));
    if (fs.existsSync(backupFile)) fs.rmSync(backupFile, { force: true });
    sqlite.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    pruneBackups(opts.backupsDir, opts.keepBackups ?? 5);
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder });
  return { db, sqlite, backupFile, close: () => sqlite.close() };
}
