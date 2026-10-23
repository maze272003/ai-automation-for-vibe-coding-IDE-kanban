// e2e/tests/appearance-card.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, createStory, forceDarkTheme, openBoard } from './aurora-helpers.ts';

let launched: Launched;

test.beforeEach(async () => {
  launched = await launchApp(makeTempDir());
  await waitReady(launched.page);
  await forceDarkTheme(launched.page);
  const id = await createInventoryProject(launched.page);
  await createStory(launched.page, id, 'Aurora card');
});

test.afterEach(async () => {
  await launched.app.close();
});

test('a story card shows its priority and attempt count', async () => {
  const { page } = launched;
  await openBoard(page);
  const card = page.getByTestId('card-INV-1');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('story-priority-INV-1')).toContainText('P2');
  await expect(card.getByTestId('story-attempts-INV-1')).toContainText('attempt');
});

test('cards never use a backdrop filter', async () => {
  const { page } = launched;
  await openBoard(page);
  const card = page.getByTestId('card-INV-1');
  await expect(card).toBeVisible();
  const filter = await card.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(filter === 'none' || filter === '').toBe(true);
});
