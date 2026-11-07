import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

async function createProjects(page: Parameters<typeof apiCall>[0]): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const [name, key] of [['Alpha', 'ALPHA'], ['Beta', 'BETA']] as const) {
    const res = await apiCall<{ id: number }>(page, 'POST', '/projects', { name, key, repoPath: makeTempRepo({ name: key.toLowerCase() }) });
    ids[key] = res.body.id;
  }
  return ids;
}

test('every imported project gets its own room in the office', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await createProjects(page);
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA DEVELOPMENT OFFICE');
  await expect(page.getByTestId('office-room-BETA')).toBeVisible();
  await expect(page.getByTestId('office-station-ALPHA-planner')).toContainText('idle');
  await page.getByLabel('Search rooms').fill('bet');
  await expect(page.getByTestId('office-room-ALPHA')).toBeHidden();
  await app.close();
});

test('deleting a project moves its room to Archived', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const ids = await createProjects(page);
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toBeVisible();
  await apiCall(page, 'DELETE', `/projects/${ids.ALPHA}`);
  await expect(page.getByTestId('office-room-ALPHA')).toBeHidden();
  await page.getByText('Archived', { exact: false }).first().click();
  await expect(page.getByTestId('office-archived')).toContainText('ALPHA');
  await app.close();
});
