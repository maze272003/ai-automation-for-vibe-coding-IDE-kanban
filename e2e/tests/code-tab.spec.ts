// e2e/tests/code-tab.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

const put = (repo: string, rel: string, content: string | Buffer) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

async function openCodeTab(page: Page, repo: string, key: string) {
  const created = await apiCall(page, 'POST', '/projects', { name: `Code ${key}`, key, repoPath: repo });
  expect(created.status).toBe(201);
  await page.reload();
  await waitReady(page);
  await page.getByTestId(`project-card-${key}`).getByRole('link').click();
  await page.getByTestId('tab-code').click();
  await page.getByTestId('file-explorer').waitFor();
}

test('code tab: browse, edit, save and search a temp checkout', async () => {
  const repo = makeTempRepo({ name: 'code-e2e' });
  put(repo, 'src/note.txt', 'a note\n');
  put(repo, 'src/glob.txt', 'literal asterisk: *\n');
  const dataDir = makeTempDir('aikanban-e2e-code-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'CODE');

    await expect(page.getByTestId('file-row-README.md')).toBeVisible();
    await expect(page.getByTestId('file-row-.git')).toHaveCount(0);
    await page.getByTestId('file-row-README.md').click();
    await expect(page.getByTestId('code-file-path')).toHaveText('README.md');
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });

    await page.locator('.monaco-editor').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('# hello from code tab');
    await expect(page.getByTestId('code-dirty')).toBeVisible();
    await page.getByTestId('code-save').click();
    await expect(page.getByTestId('code-dirty')).toHaveCount(0);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# hello from code tab');

    await page.getByTestId('code-search-toggle').click();
    // Literal glob characters must survive the bridge's URL validation.
    await page.getByTestId('code-search-input').fill('*');
    await expect(page.getByTestId('search-result-0')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('code-search-input').fill('hello');
    await expect(page.getByTestId('search-result-0')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('search-result-0')).toContainText('README.md:1:3');
    await page.getByTestId('search-result-0').click();
    await expect(page.getByTestId('code-file-path')).toHaveText('README.md');
  } finally {
    await app.close();
  }
});

test('code tab: unsaved-changes guard, folder expansion and tab navigation', async () => {
  const repo = makeTempRepo({ name: 'code-e2e-2' });
  put(repo, 'src/note.txt', 'a note\n');
  const dataDir = makeTempDir('aikanban-e2e-code2-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'CD2');
    await page.getByTestId('file-row-README.md').click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });

    await page.locator('.monaco-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nunsaved line');
    await expect(page.getByTestId('code-dirty')).toBeVisible();

    await page.getByTestId('tab-git').click();
    await expect(page.getByRole('heading', { name: 'Leave with unsaved changes?' })).toBeVisible();
    await page.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByTestId('code-toolbar')).toBeVisible();
    await expect(page.getByTestId('code-dirty')).toBeVisible();

    await page.getByTestId('file-row-src').click();
    await expect(page.getByTestId('file-row-src%2Fnote.txt')).toBeVisible();
    await page.getByTestId('file-row-src%2Fnote.txt').click();
    await expect(page.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByTestId('code-file-path')).toHaveText('README.md');
    await expect(page.getByTestId('code-dirty')).toBeVisible();

    await page.getByTestId('code-save').click();
    await expect(page.getByTestId('code-dirty')).toHaveCount(0);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('unsaved line');

    await page.getByTestId('file-row-src%2Fnote.txt').click();
    await expect(page.getByTestId('code-file-path')).toHaveText('src/note.txt');

    await page.getByTestId('tab-git').click();
    await expect(page.getByTestId('git-toolbar')).toBeVisible();
    await page.getByTestId('tab-code').click();
    await expect(page.getByTestId('code-toolbar')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('code tab: external edits produce a recoverable save conflict', async () => {
  const repo = makeTempRepo({ name: 'code-e2e-conflict' });
  put(repo, 'note.txt', 'local\n');
  const dataDir = makeTempDir('aikanban-e2e-code-conflict-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'CDC');
    await page.getByTestId('file-row-note.txt').click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });

    await page.locator('.monaco-editor').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('local edit');
    await expect(page.getByTestId('code-dirty')).toBeVisible();

    put(repo, 'note.txt', 'external\n');
    await page.getByTestId('code-save').click();
    await expect(page.getByTestId('code-conflict')).toBeVisible();
    await expect(page.getByTestId('code-save')).toBeDisabled();
    expect(fs.readFileSync(path.join(repo, 'note.txt'), 'utf8')).toBe('external\n');

    await page.getByTestId('code-conflict-reload').click();
    await page.getByTestId('code-reload-confirm').click();
    await expect(page.getByTestId('code-conflict')).toHaveCount(0);
    await expect(page.getByTestId('code-dirty')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('code tab: binary and oversized files are read-only', async () => {
  const repo = makeTempRepo({ name: 'code-e2e-3' });
  put(repo, 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]));
  put(repo, 'big.txt', `${'x'.repeat(2 * 1024 * 1024)}y`);
  const dataDir = makeTempDir('aikanban-e2e-code3-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'CD3');

    await page.getByTestId('file-row-bin.dat').click();
    await expect(page.getByTestId('code-binary-notice')).toBeVisible();
    await expect(page.getByTestId('code-save')).toBeDisabled();
    await expect(page.locator('.monaco-editor')).toHaveCount(0);

    await page.getByTestId('file-row-big.txt').click();
    await expect(page.getByTestId('code-truncated-notice')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
    await page.locator('.monaco-editor').click();
    await page.keyboard.type('ignored');
    await expect(page.getByTestId('code-save')).toBeDisabled();
    expect(fs.statSync(path.join(repo, 'big.txt')).size).toBe(2 * 1024 * 1024 + 1);
  } finally {
    await app.close();
  }
});
