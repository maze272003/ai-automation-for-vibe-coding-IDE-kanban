import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('graphics quality preference survives a reload', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  const card = page.getByTestId('settings-office3d');
  await card.getByRole('radio', { name: 'Graphics quality: Low' }).check();
  await expect(card.getByRole('radio', { name: 'Graphics quality: Low' })).toBeChecked();
  // setAppSettings is fire-and-forget from the UI; give the main process a moment to persist before reloading.
  await expect.poll(async () => (await page.evaluate(() => window.api.getAppSettings())).office3d?.quality).toBe('low');
  await page.reload();
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-office3d').getByRole('radio', { name: 'Graphics quality: Low' })).toBeChecked();
  await app.close();
});

test('renaming a room sign from the room dialog shows in quick-jump', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await apiCall(page, 'POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha' }) });
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA DEVELOPMENT OFFICE');
  await page.getByTestId('office-room-settings-ALPHA').click();
  await page.getByTestId('room-sign-name').fill('Alpha HQ');
  await page.getByRole('radio', { name: 'Icon rocket' }).check({ force: true });
  await page.getByTestId('room-settings-save').click();
  await expect(page.getByTestId('room-settings')).toBeHidden();
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA HQ');
  await app.close();
});
