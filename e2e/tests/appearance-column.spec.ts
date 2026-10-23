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

test('an empty column shows a quiet placeholder instead of a blank box', async () => {
  const { page } = launched;
  await openBoard(page);
  const column = page.getByTestId('column-NEW');
  await expect(column).toBeVisible();
  await expect(column.getByTestId('column-empty-NEW')).toBeVisible();
  await expect(column.getByTestId('column-empty-NEW')).toHaveText('Nothing here yet');
});

test('every status column paints its own signature colour', async () => {
  const { page } = launched;
  await openBoard(page);
  const expected: Record<string, string> = {
    NEW: '148, 163, 184',
    READY: '56, 189, 248',
    IN_PROGRESS: '167, 139, 250',
    TESTING: '34, 211, 238',
    READY_FOR_REVIEW: '52, 211, 153',
    REWORK: '251, 191, 36',
    BLOCKED: '251, 113, 133',
    AWAITING_MERGE: '45, 212, 191',
    DONE: '16, 185, 129',
    CANCELLED: '100, 116, 139',
  };
  for (const [status, rgb] of Object.entries(expected)) {
    const image = await page.getByTestId(`column-rail-${status}`).evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image, `${status} rail`).toContain(rgb);
  }
});
