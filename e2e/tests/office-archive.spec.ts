import { slotAt, type OfficeRoomDTO } from '@aik/contracts';
import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

type P = Parameters<typeof apiCall>[0];

async function createProject(page: P, name: string, key: string, repoPath = makeTempRepo({ name: key.toLowerCase() })): Promise<{ id: number; repoPath: string }> {
  const res = await apiCall<{ id: number }>(page, 'POST', '/projects', { name, key, repoPath });
  expect(res.status).toBeLessThan(300);
  return { id: res.body.id, repoPath };
}

const rooms = async (page: P, archived = false) =>
  (await apiCall<OfficeRoomDTO[]>(page, 'GET', `/office/rooms${archived ? '?include=archived' : ''}`)).body;

test('re-importing an archived repo (different casing) restores its room with customization', async () => {
  test.skip(process.platform !== 'win32', 'case-insensitive repo paths are a Windows behaviour');
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const alpha = await createProject(page, 'Alpha', 'ALPHA');
  const room = (await rooms(page)).find((r) => r.projectKey === 'ALPHA')!;
  await apiCall(page, 'PATCH', `/office/rooms/${room.id}`, { customization: { ...room.customization, signName: 'Alpha HQ' } });
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA HQ');

  await apiCall(page, 'DELETE', `/projects/${alpha.id}`);
  await expect(page.getByTestId('office-room-ALPHA')).toBeHidden();
  await page.getByText('Archived', { exact: false }).first().click();
  await expect(page.getByTestId('office-archived-ALPHA')).toBeVisible();

  await createProject(page, 'Alpha', 'ALPHA', alpha.repoPath.toUpperCase());
  await expect(page.getByTestId('office-room-ALPHA')).toContainText('ALPHA HQ');
  await expect(page.getByTestId('office-archived-ALPHA')).toBeHidden();
  await app.close();
});

test('delete permanently and compact layout', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await createProject(page, 'Alpha', 'ALPHA');
  const beta = await createProject(page, 'Beta', 'BETA');
  await createProject(page, 'Gamma', 'GAMMA');
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-GAMMA')).toBeVisible();

  await apiCall(page, 'DELETE', `/projects/${beta.id}`);
  await page.getByText('Archived', { exact: false }).first().click();
  await expect(page.getByTestId('office-archived-BETA')).toBeVisible();

  // Cancel keeps the room.
  await page.getByTestId('office-delete-BETA').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('office-archived-BETA')).toBeVisible();

  await page.getByTestId('office-delete-BETA').click();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('office-archived-BETA')).toBeHidden();
  expect((await rooms(page, true)).map((r) => r.projectKey).sort()).toEqual(['ALPHA', 'GAMMA']);

  // The gap at slot 1 is closed by compaction.
  expect((await rooms(page)).map((r) => r.slot)).toEqual([slotAt(0), slotAt(2)]);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByTestId('office3d-compact').click();
  await expect(page.getByText('Rooms will move to close gaps. Continue?')).toBeVisible();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('confirm-action')).toBeHidden();
  await expect.poll(async () => (await rooms(page)).map((r) => r.slot)).toEqual([slotAt(0), slotAt(1)]);
  await app.close();
});
