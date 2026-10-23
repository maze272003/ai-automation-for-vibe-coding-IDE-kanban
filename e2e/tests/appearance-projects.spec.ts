// e2e/tests/appearance-projects.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, forceDarkTheme } from './aurora-helpers.ts';

let launched: Launched;

test.beforeEach(async () => {
  launched = await launchApp(makeTempDir());
  await waitReady(launched.page);
  await forceDarkTheme(launched.page);
  await createInventoryProject(launched.page);
  // The app starts on the dashboard, so the project created through the bridge is
  // newer than its initial fetch. Leave the page via in-app routing (board.spec.ts
  // does the same) so clicking "Projects" in the test re-mounts it with the data.
  await launched.page.getByRole('link', { name: 'Settings' }).click();
});

test.afterEach(async () => {
  await launched.app.close();
});

test('projects render as a single grid of glass cards', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByTestId('project-list')).toHaveCount(1);
  await expect(page.getByTestId('project-list')).toContainText('INV · Inventory');
  await expect(page.getByTestId('project-list')).toContainText('main');
  await expect(page.getByTestId('project-card-INV')).toBeVisible();
});
