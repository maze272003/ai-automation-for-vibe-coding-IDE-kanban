import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeHits, scanStagedDiff, scanText, scanWorktree } from '../src/secrets/scan.ts';
import { makeTempRepo } from './helpers/temp.ts';

const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

describe('secret scanning — extended patterns', () => {
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

  test.each([
    ['jwt', `session ${jwt}`],
    ['api-key-header', 'x-api-key: abc123def'],
    ['api-key-header', 'API-KEY = abc123'],
    ['api-key-header', 'apikey=abc123'],
    ['cookie', 'Set-Cookie: a=1; b=2'],
    ['cookie', 'Cookie: a=1; b=2'],
    ['db-url-credentials', 'postgres://user:pass@db.example.com:5432/app'],
    ['db-url-credentials', 'postgresql://u:p@h/db'],
    ['db-url-credentials', 'mysql://u:p@h/db'],
    ['db-url-credentials', 'mariadb://u:p@h/db'],
    ['db-url-credentials', 'redis://u:p@h:6379'],
    ['db-url-credentials', 'rediss://u:p@h:6379'],
    ['db-url-credentials', 'mongodb://u:p@h/db'],
    ['db-url-credentials', 'mongodb+srv://u:p@cluster.example.net/db'],
    ['db-url-credentials', 'amqp://u:p@h:5672'],
    ['db-url-credentials', 'amqps://u:p@h:5672'],
    ['npm-token', `npm_${'d'.repeat(36)}`],
    ['gitlab-token', `glpat-${'e'.repeat(20)}`],
    ['huggingface-token', `hf_${'f'.repeat(30)}`],
  ])('names %s for a positive match', (name, text) => {
    const hits = scanText(text, 'orchestrator.log');
    expect(hits).toEqual([{ file: 'orchestrator.log', pattern: name }]);
    expect(JSON.stringify(hits)).not.toContain(text);
  });

  test.each([
    ['two-segment JWT', `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}`],
    ['short JWT segment', `eyJ${'a'.repeat(20)}.${'b'.repeat(5)}.${'c'.repeat(20)}`],
    ['api-key header without a value', 'x-api-key:'],
    ['database URL without userinfo', 'postgres://localhost:5432/app'],
    ['short npm token', `npm_${'d'.repeat(35)}`],
    ['short GitLab token', `glpat-${'e'.repeat(19)}`],
    ['short Hugging Face token', `hf_${'f'.repeat(29)}`],
  ])('does not flag %s', (_name, text) => {
    expect(scanText(text)).toEqual([]);
  });

  test('does not flag ordinary prose with cookie/token/api-key words', () => {
    expect(
      scanText('The cookie banner mentions a token budget; the api key settings page explains both.'),
    ).toEqual([]);
  });

  test('never returns secret values', () => {
    const hits = scanText(`jwt=${jwt}\ncookie: a=1\npostgres://u:p@h/db\nnpm_${'d'.repeat(36)}`);
    expect(hits.map((h) => h.pattern)).toEqual(['jwt', 'cookie', 'db-url-credentials', 'npm-token']);
    expect(JSON.stringify(hits)).not.toContain(jwt);
    expect(JSON.stringify(hits)).not.toContain('u:p@');
    expect(JSON.stringify(hits)).not.toContain('npm_');
  });
});

describe('secret scanning', () => {
  test('reports pattern names without ever returning the secret value', () => {
    const hits = scanText(`aws=${FAKE_AWS_KEY}\n`, 'config.env');
    expect(hits).toEqual([{ file: 'config.env', pattern: 'aws-access-key' }]);
    expect(JSON.stringify(describeHits(hits))).not.toContain(FAKE_AWS_KEY);
  });

  test('scans tracked files in a worktree and the staged diff before a commit', () => {
    const repo = makeTempRepo({ name: 'secrets-repo' });
    fs.writeFileSync(path.join(repo, 'config.env'), `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });

    expect(scanStagedDiff(repo)).toEqual([{ file: '(staged diff)', pattern: 'aws-access-key' }]);

    execFileSync('git', ['-c', 'user.name=aik', '-c', 'user.email=aik@localhost', 'commit', '-m', 'add config'], { cwd: repo });
    expect(scanStagedDiff(repo)).toEqual([]);
    expect(scanWorktree(repo)).toEqual([{ file: 'config.env', pattern: 'aws-access-key' }]);
  });
});
