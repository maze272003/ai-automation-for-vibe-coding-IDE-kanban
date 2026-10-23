// e2e/tests/appearance-column.spec.ts
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

test('the blocked column carries its rose accent rail', async () => {
  const { page } = launched;
  await openBoard(page);
  const rail = page.getByTestId('column-rail-BLOCKED');
  await expect(rail).toBeVisible();
  const image = await rail.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(image).toContain('251, 113, 133');
});
