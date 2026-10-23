// e2e/tests/appearance-dialogs.spec.ts
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

test('the new-story dialog traps focus and restores it on Escape', async () => {
  const { page } = launched;
  await openBoard(page);
  const trigger = page.getByTestId('new-story');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
