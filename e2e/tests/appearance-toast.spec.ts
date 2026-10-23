// e2e/tests/appearance-toast.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, forceDarkTheme, openBoard } from './aurora-helpers.ts';

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

test('the toast live region is mounted on the board', async () => {
  const { page } = launched;
  await openBoard(page);
  await expect(page.locator('[role="status"], [aria-live="polite"]').first()).toBeAttached();
});
