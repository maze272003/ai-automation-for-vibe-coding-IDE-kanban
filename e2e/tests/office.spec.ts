import { expect, test } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

async function createProjects(page: Parameters<typeof apiCall>[0]): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const [name, key] of [['Alpha', 'ALPHA'], ['Beta', 'BETA']] as const) {
    const res = await apiCall<{ id: number }>(page, 'POST', '/projects', { name, key, repoPath: makeTempRepo({ name: key.toLowerCase() }) });
    ids[key] = res.body.id;
  }
  return ids;
}

test('every imported project gets its own room in the office', async () => {
  const { app, page } = await launchApp(makeTempDir());
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Refused to')) cspErrors.push(m.text());
  });
  await waitReady(page);
  await createProjects(page);
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA DEVELOPMENT OFFICE');
  await expect(page.getByTestId('office-room-BETA')).toBeVisible();
  await expect(page.getByTestId('office-station-ALPHA-planner')).toContainText('idle');
  await page.getByLabel('Search rooms').fill('bet');
  await expect(page.getByTestId('office-room-ALPHA')).toBeHidden();
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  expect(cspErrors).toEqual([]);
  await app.close();
});

test('office navigation: fly to a room, keys from the registry, last room remembered', async () => {
  const { app, page } = await launchApp(makeTempDir());
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('Refused to')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await waitReady(page);
  const ids = await createProjects(page);
  await page.getByRole('link', { name: 'Office' }).click();
  const canvas = page.getByTestId('office-canvas').locator('canvas');
  await expect(canvas).toBeVisible();
  // Fly to a room from the quick-jump list; the selection is saved as lastRoomId after the 1 s debounce.
  await page.getByTestId('office-room-BETA').getByRole('button').first().click();
  await expect
    .poll(async () => page.evaluate(async () => (await window.api.getAppSettings()).office3d?.lastRoomId ?? null), { timeout: 5_000 })
    .not.toBeNull();
  const rooms = await apiCall<Array<{ id: number; projectId: number | null }>>(page, 'GET', '/office/rooms');
  const beta = rooms.body.find((r) => r.projectId === ids.BETA);
  expect(beta).toBeDefined();
  expect(await page.evaluate(async () => (await window.api.getAppSettings()).office3d?.lastRoomId)).toBe(beta!.id);
  // Esc back to the overview, V into walk mode (WASD), Esc / V out again; '/' focuses the room search.
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.keyboard.press('v');
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search rooms')).toBeFocused();
  // Typing 'v' in the search field types, it does not toggle walk mode.
  await page.keyboard.type('v');
  await expect(page.getByLabel('Search rooms')).toHaveValue('v');
  await expect(canvas).toBeVisible();
  expect(errors).toEqual([]);
  await app.close();
});

test('deleting a project moves its room to Archived', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const ids = await createProjects(page);
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toBeVisible();
  await apiCall(page, 'DELETE', `/projects/${ids.ALPHA}`);
  await expect(page.getByTestId('office-room-ALPHA')).toBeHidden();
  await page.getByText('Archived', { exact: false }).first().click();
  await expect(page.getByTestId('office-archived')).toContainText('ALPHA');
  await app.close();
});

/**
 * A scripted stand-in for the OpenCode service the agent runtime talks to (AIK_OPENCODE_BASE_URL is the
 * *service* URL, not the LLM URL, so the mock LLM alone cannot drive an agent run). Every session stays
 * active for `activeMs` and reports the tool parts of `tools` as they come due, which the runtime turns
 * into `run.activity` events exactly as for a real session.
 */
async function startFakeOpenCode(activeMs: number, tools: Array<{ atMs: number; name: string; path?: string }>): Promise<{ url: string; stop: () => void }> {
  const sessions = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = req.url ?? '';
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && url.startsWith('/api/model')) return json(200, { data: [{ id: 'mock-model', providerID: 'mock' }] });
      if (req.method === 'POST' && url === '/api/session') {
        sessions.set((JSON.parse(body) as { id: string }).id, Date.now());
        return json(200, {});
      }
      if (req.method === 'GET' && url === '/api/session/active') {
        return json(200, { data: [...sessions].filter(([, t]) => Date.now() - t < activeMs).map(([id]) => id) });
      }
      const m = /^\/api\/session\/([^/]+)\/(prompt|message|interrupt)/.exec(url);
      if (m && m[2] === 'message') {
        const age = Date.now() - (sessions.get(m[1]!) ?? Date.now());
        const parts = tools
          .filter((t) => t.atMs <= age)
          .map((t, i) => ({ type: 'tool', id: `p${i}`, name: t.name, state: { status: 'completed', input: { path: t.path } } }));
        return json(200, { data: [{ type: 'assistant', content: parts }] });
      }
      if (m) return json(200, {});
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stop: () => server.close() };
}

test('a story run shows its agent at the planner station in the office', async () => {
  const opencode = await startFakeOpenCode(30_000, [{ atMs: 500, name: 'read', path: 'README.md' }]);
  try {
    const { app, page } = await launchApp(makeTempDir(), { AIK_OPENCODE_BASE_URL: opencode.url });
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Refused to') || m.type() === 'error') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    await waitReady(page);
    const project = await apiCall<{ id: number }>(page, 'POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha' }) });
    await page.getByRole('link', { name: 'Office' }).click();
    await expect(page.getByTestId('office-station-ALPHA-planner')).toContainText('idle');
    // Creating a story starts planning automatically (runner discovery); the session stays active for 30 s.
    await apiCall(page, 'POST', `/projects/${project.body.id}/stories`, { title: 'Show the agent' });
    await expect(page.getByTestId('office-station-ALPHA-planner')).toContainText('planning', { timeout: 30_000 });
    const canvas = page.getByTestId('office-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    // Select the room so the walking figure and its bubble are framed; the canvas keeps rendering cleanly.
    await page.getByTestId('office-room-ALPHA').getByRole('button').first().click();
    await page.waitForTimeout(1_500);
    expect((await canvas.screenshot()).byteLength).toBeGreaterThan(1_000);
    await expect(page.getByTestId('office-station-ALPHA-planner')).toContainText('planning');
    expect(problems).toEqual([]);
    await app.close();
  } finally {
    opencode.stop();
  }
});
