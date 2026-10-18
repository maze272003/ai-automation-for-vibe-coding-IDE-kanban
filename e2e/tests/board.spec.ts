// e2e/tests/board.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
let dataDir: string;
let projectId: number;

async function openBoard(page: Page) {
  await page.getByRole('link', { name: /^INV · Inventory$/ }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}

test.beforeEach(async () => {
  dataDir = makeTempDir();
  launched = await launchApp(dataDir);
  await waitReady(launched.page);
  const created = await apiCall<{ id: number }>(launched.page, 'POST', '/projects', { name: 'Inventory', key: 'INV', repoPath: makeTempRepo() });
  projectId = created.body.id;
  // Re-mount the dashboard via in-app routing (window hardening blocks page navigations such as reload).
  await launched.page.getByRole('link', { name: 'Settings' }).click();
  await launched.page.getByRole('link', { name: 'Projects' }).click();
  await openBoard(launched.page);
});
test.afterEach(async () => {
  await launched.app.close();
});

test('creates a story from the board', async () => {
  const { page } = launched;
  await page.getByTestId('new-story').click();
  await page.getByLabel('Title').fill('Inventory module');
  await page.getByLabel('Acceptance criteria (one per line)').fill('Create works\nSearch works');
  await page.getByRole('button', { name: 'Create story' }).click();
  await expect(page.getByTestId('column-NEW').getByTestId('card-INV-1')).toContainText('Inventory module');
});

test('refuses to drag a story into DONE and explains why', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Drag me' });
  await expect(page.getByTestId('card-INV-1')).toBeVisible();
  // dragTo() cannot work here: column-DONE starts off-screen (10 columns ≈ 3012px in a 1400px
  // window) and Playwright scrolls it into view mid-gesture, which cancels the pending native drag
  // in Chromium. Reproduce the gesture explicitly: a small move starts the drag while still over
  // the card, then the board can be scrolled to reveal DONE before dropping.
  const card = page.getByTestId('card-INV-1');
  const cardBox = (await card.boundingBox())!;
  await card.hover();
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 30, cardBox.y + cardBox.height / 2, { steps: 5 });
  await page.getByTestId('column-DONE').scrollIntoViewIfNeeded();
  const doneBox = (await page.getByTestId('column-DONE').boundingBox())!;
  await page.mouse.move(doneBox.x + doneBox.width / 2, doneBox.y + doneBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole('status')).toContainText('Stories become DONE only after an approved, verified merge');
  await expect(page.getByTestId('column-NEW')).toContainText('INV-1');
});

test('cancels a story with the keyboard Move to… menu', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Cancel me' });
  const card = page.getByTestId('card-INV-1');
  await card.getByRole('button', { name: 'Move to…' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'CANCELLED' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cancel story' }).click();
  await page.getByTestId('column-CANCELLED').getByRole('button', { name: 'Show' }).click();
  await expect(page.getByTestId('column-CANCELLED')).toContainText('INV-1');
});

test('disabled moves explain themselves', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Read-only moves' });
  await page.getByTestId('card-INV-1').getByRole('button', { name: 'Move to…' }).click();
  await expect(page.getByRole('menuitem', { name: /IN_PROGRESS/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /IN_PROGRESS/ })).toHaveAttribute('title', 'Only the orchestrator moves stories from NEW to IN_PROGRESS');
});

test('search narrows the board', async () => {
  const { page } = launched;
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Alpha feature' });
  await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: 'Beta feature' });
  await page.getByLabel('Search stories').fill('alpha');
  await expect(page.getByTestId('card-INV-1')).toBeVisible();
  await expect(page.getByTestId('card-INV-2')).toHaveCount(0);
});

test('stories persist across restarts', async () => {
  await apiCall(launched.page, 'POST', `/projects/${projectId}/stories`, { title: 'Durable' });
  await launched.app.close();
  launched = await launchApp(dataDir);
  await waitReady(launched.page);
  await openBoard(launched.page);
  await expect(launched.page.getByTestId('card-INV-1')).toContainText('Durable');
});

test('renders 200 stories', async () => {
  const { page } = launched;
  for (let i = 0; i < 200; i++) await apiCall(page, 'POST', `/projects/${projectId}/stories`, { title: `Story ${i}` });
  await expect(page.locator('[data-testid^="card-"]')).toHaveCount(200, { timeout: 10_000 });
});
