// e2e/tests/git-tab.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('git tab: stage, commit, then delete detaches without touching the folder', async () => {
  const repo = makeTempRepo({ name: 'wmk-e2e' });
  const dataDir = makeTempDir('aikanban-e2e-git-');
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);

  const created = await apiCall(page, 'POST', '/projects', { name: 'We Made Kits', key: 'WMK', repoPath: repo });
  expect(created.status).toBe(201); // POST /projects answers 201 (routes/projects.ts)
  await page.reload(); // the dashboard listed projects before the bridge create — refresh to see the card
  await waitReady(page);

  // dirty the working tree, then stage + commit it from the Git tab
  fs.writeFileSync(path.join(repo, 'notes.md'), 'hello');
  await page.getByTestId('project-card-WMK').getByRole('link').click();
  await page.getByTestId('tab-git').click();
  await page.getByTestId('git-file-notes_md').waitFor();
  await page.getByTestId('git-file-notes_md').getByRole('button', { name: 'Stage notes.md' }).click();
  await expect(page.getByTestId('git-staged-group').locator('li')).toHaveCount(1);
  await page.getByTestId('git-commit-input').fill('e2e: notes');
  await page.getByTestId('git-commit').click();
  await expect(page.getByTestId('git-changes-group').locator('li')).toHaveText(['Clean tree']);

  // delete via the dashboard two-step dialog (hash-nav back — the board has no back link by design)
  await page.evaluate(() => { location.hash = '#/'; });
  await page.getByTestId('project-card-actions').click();
  await expect(page.getByTestId('project-delete-step1')).toBeVisible();
  await page.getByRole('button', { name: 'Continue…' }).click();
  await page.getByTestId('project-delete-key-input').fill('WMK');
  await page.getByTestId('project-delete-confirm').click();

  // the real folder survived, byte for byte; the app list is empty again
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# test\n');
  const list = await apiCall<{ id: number }[]>(page, 'GET', '/projects');
  expect(list.body).toEqual([]);
  await app.close();
});

test('git tab keeps commit disabled on a clean tree', async () => {
  const repo = makeTempRepo({ name: 'wmk-e2e-2' });
  const dataDir = makeTempDir('aikanban-e2e-git2-');
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  await apiCall(page, 'POST', '/projects', { name: 'Two', key: 'TWO', repoPath: repo });
  await page.reload();
  await waitReady(page);
  await page.getByTestId('project-card-TWO').getByRole('link').click();
  await page.getByTestId('tab-git').click();
  await expect(page.getByTestId('git-commit')).toBeDisabled(); // the input stays editable; the button is the guard
  await app.close();
});
