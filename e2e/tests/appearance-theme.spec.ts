// e2e/tests/appearance-theme.spec.ts
import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';
import { createInventoryProject, forceDarkTheme, token } from './aurora-helpers.ts';

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

test('the dark theme paints the Aurora canvas tokens', async () => {
  const { page } = launched;
  expect(await token(page, '--background')).toBe('#090d1a');
  expect(await token(page, '--accent')).toBe('#8b5cf6');
  expect(await token(page, '--foreground')).toBe('#eef1fb');
});

test("the theme toggle switches to the other theme's tokens", async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Settings' }).click();
  const button = page.getByRole('button', { name: /Switch to (light|dark) theme/i });
  const label = await button.textContent();
  await button.click();
  const expected = label?.includes('light') ? '#f4f4f8' : '#090d1a';
  await expect.poll(() => token(page, '--background')).toBe(expected);
});
