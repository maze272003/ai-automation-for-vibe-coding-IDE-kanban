// e2e/tests/appearance-board.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, forceDarkTheme, openBoard } from './aurora-helpers.ts';

/** The ten story statuses, in the order the board renders their columns. */
const STATUSES = [
  'NEW',
  'READY',
  'IN_PROGRESS',
  'TESTING',
  'READY_FOR_REVIEW',
  'REWORK',
  'BLOCKED',
  'AWAITING_MERGE',
  'DONE',
  'CANCELLED',
] as const;

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

test('the board renders its toolbar and all ten columns', async () => {
  const { page } = launched;
  await openBoard(page);
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
  await expect(page.getByLabel('Search stories')).toBeVisible();
  for (const status of STATUSES) {
    await expect(page.getByTestId(`column-${status}`)).toBeVisible();
  }
  await expect(page.getByTestId('new-story')).toBeVisible();
});
