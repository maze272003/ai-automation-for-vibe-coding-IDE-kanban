import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { modelUsage, openDatabase, runSkills, type OpenedDatabase } from '../src/index.ts';
import { migrationsUpTo } from './helpers/migrations-upto.ts';
import { makeTempDir } from '../../../apps/orchestrator/test/helpers/temp.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const tmp = (name: string) => makeTempDir(`aikanban-test-m4-${name}-`);
const T = 1_700_000_000_000;

function dbPaths() {
  const dir = tmp('db');
  return { file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'backups') };
}

/** Seeds through raw SQL: at 0003 the TS schema's new columns do not exist yet. */
function seed(o: OpenedDatabase, opts: { usage: boolean }) {
  const s = o.sqlite;
  const prov = s.prepare(`INSERT INTO providers (name, kind, base_url, cost_class, data_use) VALUES ('p', 'ollama', 'http://x', 'local', 'unknown')`).run();
  const prof = s.prepare(`INSERT INTO model_profiles (provider_id, model_id, context_limit, output_limit) VALUES (?, 'm', 1000, 100)`).run(prov.lastInsertRowid);
  const proj = s.prepare(`INSERT INTO projects (key, name, repo_path, base_branch, settings, created_at, updated_at) VALUES ('MU', 'Mu', 'C:/r/mu', 'main', '{}', ?, ?)`).run(T, T);
  const story = s.prepare(`INSERT INTO user_stories (project_id, key, title, rank, created_at, updated_at) VALUES (?, 'MU-1', 't', 1, ?, ?)`).run(proj.lastInsertRowid, T, T);
  const run = s.prepare(`INSERT INTO agent_runs (story_id, role, attempt, prompt_version, opencode_version, status, idempotency_key) VALUES (?, 'implementer', 1, 'v1', '0', 'succeeded', 'k-mu-1')`).run(story.lastInsertRowid);
  const ids = { profileId: Number(prof.lastInsertRowid), runId: Number(run.lastInsertRowid) };
  if (opts.usage) {
    const ins = s.prepare(`INSERT INTO model_usage (agent_run_id, model_profile_id, http_status, input_tokens, output_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run(ids.runId, ids.profileId, 200, 100, 20, 50, T);
    ins.run(null, ids.profileId, 429, null, null, 7, T + 1);
  }
  return ids;
}

const indexNames = (o: OpenedDatabase, table: string) =>
  (o.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as { name: string }[]).map((r) => r.name);

describe('migration 0004 (model_usage rebuild + run_skills)', () => {
  it('upgrades a populated 0003 database without losing model_usage rows', () => {
    const old = migrationsUpTo('0003_office_rooms', tmp('m3'));
    const p = dbPaths();
    const first = openDatabase({ ...p, migrationsFolder: old });
    const { runId, profileId } = seed(first, { usage: true });
    first.close();

    const o = openDatabase({ ...p, migrationsFolder: MIGRATIONS });
    try {
      const rows = o.db.select().from(modelUsage).orderBy(asc(modelUsage.id)).all();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        agentRunId: runId, modelProfileId: profileId, inputTokens: 100, outputTokens: 20, httpStatus: 200, latencyMs: 50,
        runtime: 'opencode', costSource: 'unknown', costUsd: null, storyId: null, projectId: null, createdAt: new Date(T),
      });
      expect(rows[1]).toMatchObject({ agentRunId: null, httpStatus: 429, inputTokens: null, latencyMs: 7, runtime: 'opencode' });
      expect(o.db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(indexNames(o, 'model_usage')).toEqual(expect.arrayContaining(['mu_profile_time_idx', 'mu_project_time_idx', 'mu_story_idx']));
      expect(indexNames(o, 'run_skills')).toContain('rs_run_skill_uq');
    } finally {
      o.close();
    }
  });

  it('accepts a per-run usage row with null profile, http status and latency', () => {
    const o = openDatabase({ ...dbPaths(), migrationsFolder: MIGRATIONS });
    try {
      const { runId } = seed(o, { usage: false });
      const row = {
        agentRunId: runId, modelProfileId: null, httpStatus: null, latencyMs: null, inputTokens: 1200, outputTokens: 300,
        runtime: 'claude', modelSlug: 'claude-sonnet', effort: 'high', costUsd: 0.0123, cachedInputTokens: 800, durationMs: 4200,
        costSource: 'reported' as const, createdAt: new Date(T),
      };
      const id = o.db.insert(modelUsage).values(row).returning({ id: modelUsage.id }).get().id;
      expect(o.db.select().from(modelUsage).all()).toEqual([{ ...row, id, fallbackFrom: null, storyId: null, projectId: null }]);
    } finally {
      o.close();
    }
  });

  it('run_skills rejects a duplicate (run, skill) pair', () => {
    const o = openDatabase({ ...dbPaths(), migrationsFolder: MIGRATIONS });
    try {
      const { runId } = seed(o, { usage: false });
      const row = { agentRunId: runId, skillId: 'sk-1', skillName: 'tdd', contentSha256: 'a'.repeat(64), createdAt: new Date(T) };
      o.db.insert(runSkills).values(row).run();
      o.db.insert(runSkills).values({ ...row, skillId: 'sk-2' }).run();
      expect(() => o.db.insert(runSkills).values(row).run()).toThrow(/UNIQUE/);
      expect(() => o.db.insert(runSkills).values({ ...row, agentRunId: 9999, skillId: 'sk-3' }).run()).toThrow(/FOREIGN KEY/);
    } finally {
      o.close();
    }
  });

  it('creates a backup before upgrading', () => {
    const p = dbPaths();
    openDatabase({ ...p, migrationsFolder: migrationsUpTo('0003_office_rooms', tmp('m3b')) }).close();
    const o = openDatabase({ ...p, migrationsFolder: MIGRATIONS });
    o.close();
    expect(o.backupFile).not.toBeNull();
    expect(fs.readdirSync(p.backupsDir).length).toBeGreaterThanOrEqual(1);
  });
});
