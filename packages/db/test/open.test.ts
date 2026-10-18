import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseCorruptError, IMMUTABLE_TABLES, openDatabase, projects } from '../src/index.ts';
import { listBackups, restoreBackup } from '../src/backup.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-db-'));
function paths() {
  const dir = tmp();
  return { file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'backups'), migrationsFolder };
}

describe('openDatabase', () => {
  it('creates every table and the immutability triggers on a fresh file', () => {
    const p = paths();
    const { sqlite, backupFile, close } = openDatabase(p);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as { name: string }[];
    expect(tables).toHaveLength(28);
    const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    expect(triggers).toHaveLength(IMMUTABLE_TABLES.length * 2);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(backupFile).toBeNull(); // nothing to back up yet
    close();
  });

  it('backs up an existing database before migrating and keeps only the newest five', () => {
    const p = paths();
    openDatabase(p).close();
    let t = Date.UTC(2026, 9, 18, 12, 0, 0);
    for (let i = 0; i < 7; i++) {
      const o = openDatabase({ ...p, now: () => new Date((t += 1000)) });
      expect(o.backupFile).not.toBeNull();
      expect(fs.existsSync(o.backupFile!)).toBe(true);
      o.close();
    }
    expect(listBackups(p.backupsDir)).toHaveLength(5);
  });

  it('refuses to open a file that is not a database', () => {
    const p = paths();
    fs.writeFileSync(p.file, 'this is not a database, just text '.repeat(200));
    expect(() => openDatabase(p)).toThrow(DatabaseCorruptError);
  });

  it('refuses to open a database with a corrupted b-tree page', () => {
    const p = paths();
    const o = openDatabase(p);
    const now = new Date();
    for (let i = 0; i < 200; i++) {
      o.db.insert(projects).values({ key: `P${i}X`, name: `Project ${i}`, repoPath: `C:/repo/${i}`, baseBranch: 'main', settings: {} as never, createdAt: now, updatedAt: now }).run();
    }
    o.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    o.close();
    const fd = fs.openSync(p.file, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096); // overwrite page 2
    fs.closeSync(fd);
    expect(() => openDatabase(p)).toThrow(DatabaseCorruptError);
  });

  it('restoreBackup moves the corrupt file aside and restores the backup', () => {
    const p = paths();
    openDatabase(p).close();
    const second = openDatabase(p);
    const backup = second.backupFile!;
    second.close(); // Windows cannot rename a file that is still open
    fs.writeFileSync(p.file, 'garbage');
    const { movedAside } = restoreBackup(backup, p.file);
    expect(movedAside).not.toBeNull();
    expect(fs.readFileSync(movedAside!, 'utf8')).toBe('garbage');
    const db = new Database(p.file);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    db.close();
  });
});
