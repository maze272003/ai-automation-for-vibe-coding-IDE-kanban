import { defaultProjectSettings, type PlanV1 } from '@aik/contracts';
import { acceptanceCriteria, openDatabase, plans, projects, userStories, type AikDb, type OpenedDatabase } from '@aik/db';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

export function createTestDb(): OpenedDatabase & { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikanban-test-orch-'));
  const o = openDatabase({ file: path.join(dir, 'app.db'), backupsDir: path.join(dir, 'backups'), migrationsFolder: MIGRATIONS });
  return { ...o, dir };
}

let counter = 0;
const now = () => new Date(1_700_000_000_000);

export function seedProject(db: AikDb, overrides: Partial<typeof projects.$inferInsert> = {}) {
  counter += 1;
  return db
    .insert(projects)
    .values({ key: `P${counter}A`, name: `Project ${counter}`, repoPath: `C:/repos/p${counter}`, baseBranch: 'main', settings: defaultProjectSettings(), createdAt: now(), updatedAt: now(), ...overrides })
    .returning()
    .get();
}

export function seedStory(db: AikDb, projectId: number, overrides: Partial<typeof userStories.$inferInsert> = {}) {
  counter += 1;
  return db
    .insert(userStories)
    .values({ projectId, key: `S-${counter}`, title: 'Inventory', description: 'CRUD', rank: counter * 1024, createdAt: now(), updatedAt: now(), ...overrides })
    .returning()
    .get();
}

export function seedAcceptanceCriterion(db: AikDb, storyId: number, text = 'Users can create records', revision = 1) {
  const ordinal = db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.storyId, storyId)).all().length + 1;
  return db.insert(acceptanceCriteria).values({ storyId, storyRevision: revision, ordinal, text, source: 'human', createdAt: now() }).returning().get();
}

export const TEST_PLAN: PlanV1 = {
  schemaVersion: 1, summary: 'Plan', assumptions: [], clarificationQuestions: [], acceptanceCriteria: [],
  subtasks: [{ id: '1', description: 'Do it', files: [] }], affectedFiles: [], requiredTests: [],
  migrations: { required: false, notes: '' }, securitySensitive: [], dependencyChanges: [], conflictsWith: [], complexity: 'S', risks: [],
};

export function seedPlan(db: AikDb, storyId: number, overrides: Partial<typeof plans.$inferInsert> = {}) {
  return db
    .insert(plans)
    .values({ storyId, version: 1, storyRevision: 1, content: TEST_PLAN, status: 'proposed', createdAt: now(), ...overrides })
    .returning()
    .get();
}

/** Test-only: put a story into an arbitrary state to set up a scenario (bypasses the workflow on purpose). */
export function forceStory(db: AikDb, id: number, patch: Partial<typeof userStories.$inferInsert>) {
  db.update(userStories).set(patch).where(eq(userStories.id, id)).run();
}
