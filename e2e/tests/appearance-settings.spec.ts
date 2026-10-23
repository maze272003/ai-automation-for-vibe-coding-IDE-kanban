// e2e/tests/appearance-settings.spec.ts — the Aurora treatment of the settings surface.
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, forceDarkTheme } from './aurora-helpers.ts';

let launched: Launched;

test.beforeEach(async () => {
  launched = await launchApp(makeTempDir());
  await waitReady(launched.page);
  await forceDarkTheme(launched.page);
  await createInventoryProject(launched.page);
});

test.afterEach(async () => {
  await launched.app.close();
});

test('settings renders the Aurora cards and keeps a real mode radio', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Settings' }).click();

  await expect(page.getByTestId('settings-appearance')).toBeVisible();
  await expect(page.getByTestId('settings-runtime')).toBeVisible();
  await expect(page.getByTestId('settings-about')).toBeVisible();

  // E6: the mode control must stay a real radio input with a label association,
  // because dashboard.spec.ts calls .check() on it.
  await expect(page.getByLabel(/App-managed OpenCode/)).toHaveAttribute('type', 'radio');
  await expect(page.getByRole('button', { name: /Switch to (light|dark) theme/i })).toBeVisible();
});
