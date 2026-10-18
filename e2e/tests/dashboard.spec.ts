import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('registers a local repository from the dashboard', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Name').fill('Inventory');
  await page.getByLabel('Key').fill('INV');
  await page.getByLabel('Repository folder').fill(makeTempRepo());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-list')).toContainText('INV · Inventory');
  await expect(page.getByTestId('project-list')).toContainText('main');
  await app.close();
});

test('suggests name and key from the chosen folder', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const repoPath = makeTempRepo();
  await page.getByLabel('Repository folder').fill(repoPath);
  await expect(page.getByLabel('Name')).toHaveValue('repo');
  await expect(page.getByLabel('Key')).toHaveValue('REPO');
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-list')).toContainText('REPO · repo');
  await app.close();
});

test('explains why a folder cannot be registered', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await page.getByLabel('Name').fill('Nope');
  await page.getByLabel('Key').fill('NOPE');
  await page.getByLabel('Repository folder').fill(makeTempDir());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-error')).toContainText('not inside a git repository');
  await app.close();
});

test('settings shows the data folder and versions', async () => {
  const dataDir = makeTempDir();
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('data-dir')).toHaveText(dataDir);
  await app.close();
});
