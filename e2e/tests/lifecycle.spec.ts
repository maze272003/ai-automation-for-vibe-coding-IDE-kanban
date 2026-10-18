// e2e/tests/lifecycle.spec.ts
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { aik, apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('board recovers after orchestrator restart', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_TEST_FAST_RESTART: '1' });
  await waitReady(page);
  const project = await apiCall<{ id: number }>(page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  const story = await apiCall<{ id: number; statusVersion: number }>(page, 'POST', `/projects/${project.body.id}/stories`, { title: 'Survives a crash' });
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'INV · Inventory' }).click();
  await expect(page.getByTestId('card-INV-1')).toBeVisible();

  const oldPid = await aik(app, (h) => h.supervisor.child?.pid as number);
  process.kill(oldPid);
  // The exit event reaches the supervisor asynchronously, so an immediate sample still shows 'ready'
  // with the dead child. Wait for the supervisor to notice before polling for the replacement.
  await expect.poll(() => aik(app, (h) => h.supervisor.state), { timeout: 20_000 }).not.toBe('ready');
  await expect.poll(() => aik(app, (h) => (h.supervisor.state === 'ready' ? h.supervisor.child?.pid : null)), { timeout: 20_000 }).not.toBeNull();
  expect(await aik(app, (h) => h.supervisor.child?.pid)).not.toBe(oldPid);

  // Changes made after the restart reach the board through the reconnected event stream…
  await apiCall(page, 'POST', `/stories/${story.body.id}/transitions`, { event: 'hold', expectedVersion: story.body.statusVersion });
  await expect(page.getByTestId('card-INV-1')).toContainText('on hold');
  await apiCall(page, 'POST', `/projects/${project.body.id}/stories`, { title: 'Created after restart' });
  await expect(page.getByTestId('card-INV-2')).toBeVisible();
  // …and the UI's statusVersion is fresh, so a move succeeds without a reload.
  await page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'CANCELLED' }).click();
  await page.getByRole('button', { name: 'Cancel story' }).click();
  await expect(page.getByTestId('column-CANCELLED')).toContainText('1');
  await app.close();
});

test('quitting leaves no orphaned orchestrator', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const pid = await aik(app, (h) => h.supervisor.child?.pid as number);
  await app.close();
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
});

test('a crash loop shows the failure screen', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_TEST_CRASH_ORCHESTRATOR: '1', AIK_TEST_FAST_RESTART: '1' });
  await expect(page.getByTestId('system-failure')).toContainText('keeps crashing', { timeout: 20_000 });
  await app.close();
});

test('a corrupt database can be restored from the latest backup', async () => {
  const dataDir = makeTempDir();
  let run = await launchApp(dataDir);
  await waitReady(run.page);
  await apiCall(run.page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  await run.app.close();
  run = await launchApp(dataDir); // second start writes a backup of the healthy database
  await waitReady(run.page);
  await run.app.close();

  fs.writeFileSync(path.join(dataDir, 'app.db'), 'corrupted '.repeat(1000));
  run = await launchApp(dataDir);
  await expect(run.page.getByTestId('system-failure')).toContainText('could not start');
  await run.page.getByRole('button', { name: 'Restore latest backup' }).click();
  await waitReady(run.page);
  await expect(run.page.getByTestId('project-list')).toContainText('INV · Inventory');
  await run.app.close();
});
