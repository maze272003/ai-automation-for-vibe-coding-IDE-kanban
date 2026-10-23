// e2e/tests/appearance-menu.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, createStory, forceDarkTheme, openBoard } from './aurora-helpers.ts';

let launched: Launched;

test.beforeEach(async () => {
  launched = await launchApp(makeTempDir());
  await waitReady(launched.page);
  await forceDarkTheme(launched.page);
  const id = await createInventoryProject(launched.page);
  await createStory(launched.page, id, 'Menu card');
});

test.afterEach(async () => {
  await launched.app.close();
});

test('the move menu is portalled out of the card and still lists raw statuses', async () => {
  const { page } = launched;
  await openBoard(page);
  const trigger = page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const insideCard = await menu.evaluate((el) => el.closest('[data-testid^="card-"]') !== null);
  expect(insideCard).toBe(false);
  await expect(page.getByRole('menuitem', { name: 'CANCELLED' })).toBeVisible();
});
