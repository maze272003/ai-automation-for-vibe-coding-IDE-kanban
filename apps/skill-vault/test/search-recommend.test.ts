// apps/skill-vault/test/search-recommend.test.ts — ranking, filters, offline operation,
// codebase-aware recommendations, overlap suppression.
import { describe, expect, it } from 'vitest';
import { VaultDb } from '../src/db.ts';
import { searchSkills } from '../src/search.ts';
import { recommendForRepo } from '../src/recommend.ts';
import { writeRepo } from './helpers/fixtures.ts';
import { makeTempDir } from './helpers/temp.ts';

const seedRow = (
  db: VaultDb,
  id: string,
  name: string,
  description: string,
  status: string,
  stars: number,
  owner = 'a',
  repo = 'r',
): void => {
  db.db
    .prepare(
      `INSERT INTO skills (id, source, name, description, author, repo_owner, repo_name, repo_url, skill_path,
        category, stars, skill_url, discovered_at, last_seen_at, status)
       VALUES (?, 'skillsmp', ?, ?, ?, ?, ?, ?, ?, 'coding', ?, ?, ?, ?, ?)`,
    )
    .run(id, name, description, owner, owner, repo, `https://github.com/${owner}/${repo}`, '.', stars, `https://skillsmp.com/${id}`, new Date().toISOString(), new Date().toISOString(), status);
};

describe('search ranking and filters', () => {
  const setup = () => {
    const root = makeTempDir();
    const db = VaultDb.open(`${root}/indexes/metadata.sqlite`.replaceAll('\\', '/'));
    seedRow(db, '1', 'react-best-practices', 'React performance patterns', 'scanned', 500);
    seedRow(db, '2', 'react-testing', 'Testing React with vitest', 'scanned', 50);
    seedRow(db, '3', 'python-testing', 'Testing python code', 'scanned', 80);
    seedRow(db, '4', 'react-secret', 'React but quarantined content', 'quarantined', 900);
    seedRow(db, '5', 'approved-react', 'React approved skill', 'approved', 30);
    return db;
  };

  it('ranks exact name matches above description matches and boosts approved skills', () => {
    const db = setup();
    const hits = searchSkills(db, { query: 'react', limit: 10 });
    expect(hits.length).toBe(3); // quarantined excluded by default
    // approved-react gets the +3 approval boost; the exact-name hit comes next; description-only last
    expect(hits.map((hit) => hit.row.name)).toEqual(['approved-react', 'react-best-practices', 'react-testing']);
  });

  it('boosts approved skills', () => {
    const db = setup();
    const hits = searchSkills(db, { query: 'react approved', limit: 10 });
    expect(hits[0]?.row.name).toBe('approved-react');
  });

  it('applies min-star and explicit status filters', () => {
    const db = setup();
    const hits = searchSkills(db, { query: 'testing', filters: { minStars: 60 }, limit: 10 });
    expect(hits.map((hit) => hit.row.name)).toEqual(['python-testing']);
    const quarantined = searchSkills(db, { query: 'react', filters: { statuses: ['quarantined'] }, limit: 10 });
    expect(quarantined.map((hit) => hit.row.name)).toEqual(['react-secret']);
  });

  it('works offline: no fetch is performed (pure local SQLite)', () => {
    const db = setup();
    const hits = searchSkills(db, { query: 'python', limit: 5 });
    expect(hits.length).toBe(1);
  });
});

describe('codebase-aware recommendations', () => {
  const setup = () => {
    const root = makeTempDir();
    const db = VaultDb.open(`${root}/indexes/metadata.sqlite`.replaceAll('\\', '/'));
    seedRow(db, '1', 'react-patterns', 'React component patterns and hooks', 'scanned', 400, 'vercel', 'skills');
    seedRow(db, '2', 'react-testing', 'React testing recipes', 'scanned', 200, 'vite', 'skills');
    seedRow(db, '3', 'rust-performance', 'Rust performance tuning', 'scanned', 300, 'rust', 'skills');
    seedRow(db, '4', 'react-patterns-v2', 'React component patterns v2', 'scanned', 10, 'other', 'repo');
    return db;
  };

  it('prefers skills matching the repo stack and suppresses overlaps', async () => {
    const db = setup();
    const repo = writeRepo({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { react: '^19.0.0', vite: '^8.0.0' } }),
      'src/App.tsx': 'export default function App() { return null; }',
    });
    const result = await recommendForRepo(db, { repoRoot: repo, task: 'optimize React rendering' });
    expect(result.terms).toContain('react');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0]?.skill.name).toBe('react-patterns');
    // Overlap suppression: same-repo skills are skipped in favor of broader coverage first.
    expect(result.overlaps.length).toBeGreaterThan(0);
    expect(result.recommendations.every((rec, index, all) => all.slice(index + 1).every((other) => other.skill.id !== rec.skill.id))).toBe(true);
  });

  it('warns when nothing relevant exists and recommends continuing without skills', async () => {
    const db = setup();
    const repo = writeRepo({ 'go.mod': 'module example.com/x\n', 'main.go': 'package main\n' });
    const result = await recommendForRepo(db, { repoRoot: repo, task: 'write a fortran compiler' });
    expect(result.recommendations.length).toBe(0);
    expect(result.warnings.some((warning: string) => warning.includes('No relevant'))).toBe(true);
  });

  it('never recommends quarantined or rejected content', async () => {
    const root = makeTempDir();
    const db = VaultDb.open(`${root}/indexes/metadata.sqlite`.replaceAll('\\', '/'));
    seedRow(db, '1', 'react-evil', 'React but malicious', 'quarantined', 5000);
    const repo = writeRepo({ 'package.json': JSON.stringify({ dependencies: { react: '*' } }) });
    const result = await recommendForRepo(db, { repoRoot: repo, task: 'react' });
    expect(result.recommendations.length).toBe(0);
  });
});
