import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeApprovals, openDatabase, projects, storyEvents, userStories, workspaces, type OpenedDatabase } from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
let o: OpenedDatabase;
let storyId: number;
const now = new Date();

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-db-'));
  o = openDatabase({ file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'b'), migrationsFolder });
  const p = o.db.insert(projects).values({ key: 'INV', name: 'Inv', repoPath: 'C:/r', baseBranch: 'main', settings: {} as never, createdAt: now, updatedAt: now }).returning().get();
  storyId = o.db.insert(userStories).values({ projectId: p.id, key: 'INV-1', title: 't', rank: 1, createdAt: now, updatedAt: now }).returning().get().id;
  return () => o.close();
});

describe('constraints', () => {
  it('story_events is append-only', () => {
    o.db.insert(storyEvents).values({ storyId, type: 'created', actor: 'human', createdAt: now }).run();
    expect(() => o.sqlite.prepare("UPDATE story_events SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => o.sqlite.prepare('DELETE FROM story_events').run()).toThrow(/append-only/);
  });

  it('rejects malformed SHAs', () => {
    expect(() => o.sqlite.prepare("UPDATE user_stories SET candidate_sha = 'abc' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare('UPDATE user_stories SET candidate_sha = ? WHERE id = ?').run('a'.repeat(64), storyId)).not.toThrow();
  });

  it('BLOCKED ⇔ blocked_reason', () => {
    expect(() => o.sqlite.prepare("UPDATE user_stories SET status = 'BLOCKED' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare("UPDATE user_stories SET blocked_reason = 'quota' WHERE id = ?").run(storyId)).toThrow(/CHECK/);
    expect(() => o.sqlite.prepare("UPDATE user_stories SET status = 'BLOCKED', blocked_reason = 'quota' WHERE id = ?").run(storyId)).not.toThrow();
  });

  it('allows one non-removed workspace per path', () => {
    const w = { storyId, kind: 'story' as const, path: 'C:/wt/INV-1', createdAt: now };
    o.db.insert(workspaces).values({ ...w, status: 'removed' }).run();
    o.db.insert(workspaces).values({ ...w, status: 'active' }).run();
    expect(() => o.db.insert(workspaces).values({ ...w, status: 'preserved' }).run()).toThrow(/UNIQUE/);
  });

  it('merge approvals are unique per story, kind and SHA and immutable', () => {
    const a = { storyId, kind: 'merge' as const, commitSha: 'a'.repeat(40), approvedAt: now };
    o.db.insert(mergeApprovals).values(a).run();
    expect(() => o.db.insert(mergeApprovals).values(a).run()).toThrow(/UNIQUE/);
    expect(() => o.sqlite.prepare("UPDATE merge_approvals SET note = 'x'").run()).toThrow(/append-only/);
  });

  it('enforces foreign keys', () => {
    expect(() => o.db.insert(storyEvents).values({ storyId: 999, type: 'x', actor: 'human', createdAt: now }).run()).toThrow(/FOREIGN KEY/);
  });
});
