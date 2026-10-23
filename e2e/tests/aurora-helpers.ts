// e2e/tests/aurora-helpers.ts — shared helpers for the Aurora appearance specs.
//
// Every appearance spec owns its own file so that parallel work never edits the
// same spec. They all import from here instead of re-inventing the setup.
import { expect, type Page } from '@playwright/test';
import { apiCall, makeTempRepo } from '../fixtures.ts';

/** The project every appearance spec creates in its beforeEach. */
export const INVENTORY = { name: 'Inventory', key: 'INV' } as const;

/** Creates the INV project and returns its id. */
export async function createInventoryProject(page: Page): Promise<number> {
  const res = await apiCall<{ id: number }>(page, 'POST', '/projects', {
    name: INVENTORY.name,
    key: INVENTORY.key,
    repoPath: makeTempRepo(),
  });
  return res.body.id;
}

/** Creates one story in the project and returns its id. The first is always <KEY>-1. */
export async function createStory(page: Page, projectId: number, title: string): Promise<number> {
  const res = await apiCall<{ id: number }>(page, 'POST', `/projects/${projectId}/stories`, { title });
  return res.body.id;
}

/** Resolves a semantic custom property on the document root. */
export async function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/**
 * Forces the dark theme.
 *
 * The Electron user-data directory persists localStorage across launches inside a
 * single Playwright run, so a spec that switches to light would otherwise leak
 * that setting into every later spec.
 */
export async function forceDarkTheme(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('aik.theme', 'dark');
    document.documentElement.classList.add('dark');
  });
}

/** Navigates to the INV board from anywhere in the app. */
export async function openBoard(page: Page): Promise<void> {
  // The dashboard fetches its project list on mount, so clicking "Projects"
  // while already on the dashboard does not refetch it. Hop through Settings
  // first so the project created in beforeEach is actually listed.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: /^INV · Inventory$/ }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}
