import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
test.beforeEach(async () => { launched = await launchApp(makeTempDir()); await waitReady(launched.page); });
test.afterEach(async () => { await launched?.app.close(); });
test('dispatches all seven global shortcuts and closes help with Escape', async () => {
  const { page } = launched;
  for (const [chord, hash] of [['Control+2', '#/usage'], ['Control+3', '#/office'], ['Control+,', '#/settings'], ['Control+Shift+D', '#/diagnostics'], ['Control+1', '#/']] as const) {
    await page.keyboard.press(chord);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(hash);
  }
  const theme = await page.locator('html').getAttribute('class');
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('html')).not.toHaveAttribute('class', theme ?? '');
  await page.keyboard.press('F1');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
});
test('opens shortcut help from the sidebar and Settings', async () => {
  const { page } = launched;
  await page.getByTestId('app-sidebar').getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
});
