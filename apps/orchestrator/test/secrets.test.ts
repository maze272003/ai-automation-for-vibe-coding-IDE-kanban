import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeHits, scanStagedDiff, scanText, scanWorktree } from '../src/secrets/scan.ts';
import { makeTempRepo } from './helpers/temp.ts';

const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

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
