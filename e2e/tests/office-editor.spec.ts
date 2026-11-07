import type { OfficeRoomDTO } from '@aik/contracts';
import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

test('adding a plant in the room editor persists the layout', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await apiCall(page, 'POST', '/projects', { name: 'Alpha', key: 'ALPHA', repoPath: makeTempRepo({ name: 'alpha' }) });
  await page.getByRole('link', { name: 'Office' }).click();
  await expect(page.getByTestId('office-room-ALPHA')).toBeVisible();
  await page.getByTestId('office-room-settings-ALPHA').click();
  await page.getByTestId('room-edit-layout').click();
  await expect(page.getByTestId('room-editor')).toBeVisible();

  await page.getByTestId('editor-add-plant').click();
  await expect(page.getByTestId('editor-error')).toHaveText('');
  await page.getByTestId('room-editor-save').click();
  await expect(page.getByTestId('room-editor')).toBeHidden();

  await page.reload();
  await waitReady(page);
  const rooms = (await apiCall<OfficeRoomDTO[]>(page, 'GET', '/office/rooms')).body;
  const layout = rooms.find((r) => r.projectKey === 'ALPHA')!.customization.layout;
  expect(layout?.filter((i) => i.kind === 'plant').length).toBe(2);
  expect(layout?.some((i) => i.id === 'plant-1')).toBe(true);
  await app.close();
});

test('delete works, special items are protected, and Reset to default clears the layout', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await apiCall(page, 'POST', '/projects', { name: 'Beta', key: 'BETA', repoPath: makeTempRepo({ name: 'beta' }) });
  await page.getByRole('link', { name: 'Office' }).click();
  await page.getByTestId('office-room-settings-BETA').click();
  await page.getByTestId('room-edit-layout').click();
  await page.getByTestId('editor-add-plant').click();
  await page.getByTestId('editor-item-plant-1').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('editor-item-plant-1')).toHaveCount(0);
  await page.getByTestId('editor-item-coffee').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('editor-error')).toContainText('moved but not removed');
  await page.getByTestId('room-editor-reset').click();
  await expect(page.getByTestId('room-editor')).toBeHidden();
  const rooms = (await apiCall<OfficeRoomDTO[]>(page, 'GET', '/office/rooms')).body;
  expect(rooms.find((r) => r.projectKey === 'BETA')!.customization.layout).toBeNull();
  await app.close();
});
