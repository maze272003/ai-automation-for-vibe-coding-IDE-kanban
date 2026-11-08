import { expect, test } from '@playwright/test';
import { launchApp, makeTempDir, waitReady, type Launched } from '../fixtures.ts';

let launched: Launched;
test.beforeEach(async () => { launched = await launchApp(makeTempDir()); await waitReady(launched.page); });
test.afterEach(async () => { await launched?.app.close(); });
test('opens Diagnostics from the sidebar and creates a backup', async () => {
  const { page } = launched;
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByTestId('diagnostics-health')).toBeVisible();
  await expect(page.getByTestId('diagnostics-health').getByRole('alert')).toHaveCount(0);
  const backups = page.getByTestId('diagnostics-backup-item');
  const count = await backups.count();
  await page.getByTestId('diagnostics-backup-create').click();
  await expect(backups).toHaveCount(count + 1);
});
