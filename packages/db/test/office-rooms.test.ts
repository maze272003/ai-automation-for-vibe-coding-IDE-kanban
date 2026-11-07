import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { officeRooms, openDatabase, projects, type OpenedDatabase } from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let o: OpenedDatabase;
const now = new Date();

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-db-'));
  o = openDatabase({ file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'b'), migrationsFolder });
  return () => o.close();
});

const customization = { signName: null, accentColor: '#f59e0b', icon: null, screens: null, layout: null };

describe('office_rooms', () => {
  it('enforces unique repo path and unique occupied slot', () => {
    const row = { repoPathNorm: 'c:/r/a', projectKeySnapshot: 'A', projectNameSnapshot: 'A', wing: 'N', slotIndex: 0, side: 'L',
      customization, createdAt: now, updatedAt: now } as const;
    o.db.insert(officeRooms).values(row).run();
    expect(() => o.db.insert(officeRooms).values({ ...row, wing: 'E' }).run()).toThrow(/UNIQUE/);
    expect(() => o.db.insert(officeRooms).values({ ...row, repoPathNorm: 'c:/r/b' }).run()).toThrow(/UNIQUE/);
    o.db.insert(officeRooms).values({ ...row, repoPathNorm: 'c:/r/c', wing: null, slotIndex: null, side: null }).run();
    o.db.insert(officeRooms).values({ ...row, repoPathNorm: 'c:/r/d', wing: null, slotIndex: null, side: null }).run();
  });

  it('deleting a project does not touch office_rooms (no FK)', () => {
    const p = o.db.insert(projects).values({ key: 'OFC', name: 'Ofc', repoPath: 'C:/r', baseBranch: 'main', settings: {} as never, createdAt: now, updatedAt: now }).returning().get();
    o.db.insert(officeRooms).values({ repoPathNorm: 'c:/r', projectId: p.id, projectKeySnapshot: 'OFC', projectNameSnapshot: 'Ofc', customization, createdAt: now, updatedAt: now }).run();
    o.sqlite.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    const rooms = o.db.select().from(officeRooms).all();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.projectId).toBe(p.id);
  });
});
