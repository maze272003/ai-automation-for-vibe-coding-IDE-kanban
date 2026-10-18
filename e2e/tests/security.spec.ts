// e2e/tests/security.spec.ts
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import electronPath from 'electron';
import { aik, apiCall, distDir, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

const rawGet = (port: number, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });

test('the renderer has no Node access and never sees the API token', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const token = await aik(app, (h) => h.token);
  const probe = await page.evaluate((t) => {
    const g = globalThis as unknown as Record<string, unknown>;
    return {
      require: typeof g.require,
      process: typeof g.process,
      api: typeof (window as unknown as { api: { request: unknown } }).api.request,
      leaked: [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie].some((s) => s.includes(t)),
    };
  }, token);
  expect(probe).toEqual({ require: 'undefined', process: 'undefined', api: 'function', leaked: false });
  await app.close();
});

test('neither persisted log file ever contains the API token', async () => {
  const dataDir = makeTempDir();
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  // Generate some orchestrator activity so both log sinks have flushed content.
  await apiCall(page, 'POST', '/projects', { name: 'Logs', key: 'LOG', repoPath: makeTempRepo() });
  const token = await aik(app, (h) => h.token);
  for (const file of ['orchestrator.log', 'orchestrator-stdio.log']) {
    const p = path.join(dataDir, 'logs', file);
    expect(fs.existsSync(p), `${file} exists`).toBe(true);
    expect(fs.readFileSync(p, 'utf8'), `${file} must not contain the token`).not.toContain(token);
  }
  await app.close();
});

test('CSP blocks injected inline scripts', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const pwned = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = 1';
    document.body.appendChild(s);
    return (window as unknown as { __pwned?: number }).__pwned ?? null;
  });
  expect(pwned).toBeNull();
  await app.close();
});

test('navigation away and window.open are blocked', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const before = page.url();
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(1000);
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true);
  expect(app.windows()).toHaveLength(1);
  await app.close();
});

test('the API rejects missing tokens, foreign hosts and foreign origins', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const { port, token } = await aik(app, (h) => ({ port: h.supervisor.port as number, token: h.token }));
  expect(await rawGet(port, {})).toBe(401);
  expect(await rawGet(port, { authorization: `Bearer ${token}`, host: 'evil.example' })).toBe(403);
  expect(await rawGet(port, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).toBe(403);
  expect(await rawGet(port, { authorization: `Bearer ${token}` })).toBe(200);
  await app.close();
});

test('a second instance exits and leaves the first one working', async () => {
  const dataDir = makeTempDir();
  const first = await launchApp(dataDir);
  await waitReady(first.page);
  const second = spawn(electronPath as unknown as string, [distDir], { env: { ...process.env, AIK_DATA_DIR: dataDir, AIK_E2E: '1' }, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve) => second.once('exit', resolve));
  expect(code).toBe(0);
  expect((await apiCall(first.page, 'GET', '/health')).status).toBe(200);
  await first.app.close();
});
