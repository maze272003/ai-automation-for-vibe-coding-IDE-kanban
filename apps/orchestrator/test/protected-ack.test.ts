import { storyEvents } from '@aik/db';
import { afterEach, describe, expect, it } from 'vitest';
import { protectedPathsForCandidate, sameProtectedPaths } from '../src/stories/protected-ack.ts';
import { createTestDb, seedProject, seedStory } from './helpers/db.ts';
import { makeTempDir } from './helpers/temp.ts';

describe('protected candidate paths', () => {
  const t = createTestDb();
  afterEach(() => t.close());

  it('selects the latest transition for the requested candidate and normalizes its paths', () => {
    const project = seedProject(t.db, { repoPath: makeTempDir() });
    const story = seedStory(t.db, project.id);
    const insert = (sha: string, protectedPaths: string[], type = 'transition') => t.db.insert(storyEvents).values({
      storyId: story.id, type, actor: 'agent:implementer', createdAt: new Date(),
      payload: { event: { type: 'candidate_committed', candidateSha: sha, protectedPaths } },
    }).run();
    insert('a'.repeat(40), ['obsolete']);
    insert('a'.repeat(40), ['z', 'a\\x', 'a/x']);
    insert('b'.repeat(40), ['other']);
    insert('a'.repeat(40), ['ignored'], 'not-a-transition');
    expect(protectedPathsForCandidate(t.db, story.id, 'a'.repeat(40))).toEqual(['a/x', 'z']);
    expect(protectedPathsForCandidate(t.db, story.id, 'b'.repeat(40))).toEqual(['other']);
    expect(protectedPathsForCandidate(t.db, story.id, 'c'.repeat(40))).toEqual([]);
  });
});

it('compares normalized sets without order or duplicate sensitivity', () => {
  expect(sameProtectedPaths(['b', 'a\\x', 'b'], ['a/x', 'b'])).toBe(true);
  expect(sameProtectedPaths(['a'], ['b'])).toBe(false);
  expect(sameProtectedPaths([], [])).toBe(true);
});
