import { expect, it } from 'vitest';
import { agentRuns, runSkills, type AikDb } from '@aik/db';
import { recordRunSkills } from '../src/skills/run-skills.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';

let runCounter = 0;

function seedRun(db: AikDb, storyId: number) {
  runCounter += 1;
  return db
    .insert(agentRuns)
    .values({
      storyId, role: 'planner', attempt: 1, promptVersion: '1.0',
      opencodeVersion: '2.0.32', status: 'running', idempotencyKey: `run_skills_${runCounter}`,
      startedAt: new Date(1_000),
    })
    .returning()
    .get();
}

const DELIVERED = [
  { id: 'gh:obra/superpowers/writing-plans', name: 'writing-plans', contentSha256: 'a'.repeat(64), bytes: 148 },
  { id: 'gh:react-community/react-forms/react-forms', name: 'react-forms', contentSha256: 'b'.repeat(64), bytes: 184 },
];

it('inserts one run_skills row per delivered skill', () => {
  const t = createTestDb();
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const run = seedRun(t.db, story.id);
  const now = new Date(5_000);

  recordRunSkills(t.db, now, run.id, DELIVERED);

  const rows = t.db.select().from(runSkills).all();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    agentRunId: run.id, skillId: DELIVERED[0].id, skillName: 'writing-plans',
    contentSha256: DELIVERED[0].contentSha256, createdAt: now,
  });
  expect(rows[1]).toMatchObject({
    agentRunId: run.id, skillId: DELIVERED[1].id, skillName: 'react-forms',
    contentSha256: DELIVERED[1].contentSha256, createdAt: now,
  });
  t.close();
});

it('repeating the call for the same run adds no rows', () => {
  const t = createTestDb();
  const project = seedProject(t.db);
  const story = seedStory(t.db, project.id);
  const run = seedRun(t.db, story.id);

  recordRunSkills(t.db, new Date(5_000), run.id, DELIVERED);
  recordRunSkills(t.db, new Date(6_000), run.id, DELIVERED);

  expect(t.db.select().from(runSkills).all()).toHaveLength(2);
  t.close();
});
