import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
test.beforeEach(async () => {
  launched = await launchApp(makeTempDir());
  await waitReady(launched.page);
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'echo test', lint: 'echo lint' } }));
  const result = await apiCall(launched.page, 'POST', '/projects', { name: 'Settings project', key: 'CFG', repoPath: repo });
  expect(result.status).toBe(201);
  await launched.page.getByRole('link', { name: 'Settings', exact: true }).click();
  await launched.page.getByRole('link', { name: 'Projects', exact: true }).click();
  await launched.page.getByRole('link', { name: 'CFG · Settings project', exact: true }).click();
});
test.afterEach(async () => { await launched?.app.close(); });

test('detects checks, saves the draft and shows nested validation errors', async () => {
  const { page } = launched;
  await expect(page.getByTestId('checks-banner')).toBeVisible();
  await page.getByTestId('checks-banner-open').click();
  await expect(page.getByTestId('project-settings')).toBeVisible();
  await expect(page.getByTestId('settings-field-checks.0.key')).toHaveValue('test');
  await expect(page.getByTestId('settings-field-checks.1.key')).toHaveValue('lint');
  await expect(page.getByTestId('settings-group-safety')).toContainText('Not enforced yet — agents may run any command.');
  await expect(page.getByTestId('scanner-status')).toBeVisible();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await page.getByRole('link', { name: 'Back to board' }).click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('checks-banner')).toHaveCount(0);
  await page.getByTestId('tab-settings').click();
  const command = page.getByTestId('settings-field-checks.0.command');
  await command.fill('');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toBeVisible();
  await expect(command).toHaveAttribute('aria-invalid', 'true');
  const errorId = await command.getAttribute('aria-describedby');
  expect(errorId).toBeTruthy();
  await expect(page.locator(`[id="${errorId}"]`)).toBeVisible();
  await expect(command).toHaveValue('');
});
