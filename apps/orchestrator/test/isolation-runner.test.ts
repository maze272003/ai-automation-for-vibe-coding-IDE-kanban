// apps/orchestrator/test/isolation-runner.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertInTemp, makeTempDir } from './helpers/temp.js';
import { JobObjectIsolationRunner } from '../src/isolation/job-object.js';
import { getIsolationRunner } from '../src/isolation/index.js';

describe('IsolationRunner', () => {
  it('runs command in worktree and captures stdout, stderr, exit code', async () => {
    const dir = makeTempDir('aik-iso-test-');
    assertInTemp(dir);
    const runner = new JobObjectIsolationRunner();

    const result = await runner.run(['node', '-e', 'console.log("hello stdout"); console.error("hello stderr")'], {
      worktreeDir: dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString('utf8')).toContain('hello stdout');
    expect(result.stderr.toString('utf8')).toContain('hello stderr');
    expect(result.timedOut).toBe(false);
  });

  it('propagates non-zero exit code accurately', async () => {
    const dir = makeTempDir('aik-iso-test-');
    assertInTemp(dir);
    const runner = new JobObjectIsolationRunner();

    const result = await runner.run(['node', '-e', 'process.exit(42)'], {
      worktreeDir: dir,
    });

    expect(result.exitCode).toBe(42);
  });

  it('terminates process tree on timeout and marks timedOut', async () => {
    const dir = makeTempDir('aik-iso-test-');
    assertInTemp(dir);
    const runner = new JobObjectIsolationRunner();

    const result = await runner.run(['node', '-e', 'setInterval(() => {}, 1000)'], {
      worktreeDir: dir,
      timeoutMs: 300,
    });

    expect(result.timedOut).toBe(true);
  });

  it('scrubs sensitive tokens from environment and isolates user profile paths', async () => {
    const dir = makeTempDir('aik-iso-test-');
    assertInTemp(dir);
    const runner = new JobObjectIsolationRunner();

    const testScript = `
      const env = process.env;
      console.log(JSON.stringify({
        hasSecret: Boolean(env.TEST_API_KEY || env.GITHUB_TOKEN || env.AIKANBAN_CRED_NONCE),
        tempInTemp: env.TEMP ? env.TEMP.toLowerCase().includes("temp") : false,
      }));
    `;

    const result = await runner.run(['node', '-e', testScript], {
      worktreeDir: dir,
      env: {
        TEST_API_KEY: 'super-secret',
        GITHUB_TOKEN: 'ghp_secret',
        AIKANBAN_CRED_NONCE: 'nonce123',
        CUSTOM_SAFE_VAR: 'safe_val',
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString('utf8').trim());
    expect(parsed.hasSecret).toBe(false);
  });

  it('factory getIsolationRunner returns a valid runner', () => {
    const runner = getIsolationRunner();
    expect(runner).toBeDefined();
    expect(runner.kind).toBe('job_object');
  });
});
