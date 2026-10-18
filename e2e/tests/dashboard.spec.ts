import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTempDir, makeTempRepo, resolveOpencodeExe, startMockLlm, waitReady } from '../fixtures.ts';

/** A fake `opencode --version` used to drive the managed-install status UI without a 220 MB download. */
const opencodeStub = (version: string): string => {
  const stub = path.join(makeTempDir(), 'opencode.cmd');
  fs.writeFileSync(stub, `@echo off\r\necho opencode v${version}\r\n`);
  return stub;
};

test('registers a local repository from the dashboard', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Name').fill('Inventory');
  await page.getByLabel('Key').fill('INV');
  await page.getByLabel('Repository folder').fill(makeTempRepo());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-list')).toContainText('INV · Inventory');
  await expect(page.getByTestId('project-list')).toContainText('main');
  await app.close();
});

test('suggests name and key from the chosen folder', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  const repoPath = makeTempRepo();
  await page.getByLabel('Repository folder').fill(repoPath);
  await expect(page.getByLabel('Name')).toHaveValue('repo');
  await expect(page.getByLabel('Key')).toHaveValue('REPO');
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-list')).toContainText('REPO · repo');
  await app.close();
});

test('shows the underlying error when the model call fails', async () => {
  const exe = resolveOpencodeExe();
  test.skip(!exe, 'no OpenCode binary available (spike copy or managed install)');
  // Mirrors the real gateway 403 FreeTierError (fails fast, no retries) that used to surface as
  // a misleading "The model returned no text".
  const fault = { status: 403, errorMessage: "OpenCode's free tier can only be used from within OpenCode" };
  const mock = await startMockLlm([fault]);
  try {
    const { app, page } = await launchApp(makeTempDir(), { AIK_OPENCODE_EXE: exe!, AIK_OPENCODE_BASE_URL: mock.url });
    await waitReady(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByLabel('Default model')).toHaveValue('mock/mock-model', { timeout: 30_000 });
    await page.getByLabel('Test prompt').fill('Say hello.');
    await page.getByRole('button', { name: 'Send test prompt' }).click();
    await expect(page.getByTestId('model-test-reply')).toContainText('free tier', { timeout: 60_000 });
    await app.close();
  } finally {
    mock.stop();
  }
});

test('explains why a folder cannot be registered', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await page.getByLabel('Name').fill('Nope');
  await page.getByLabel('Key').fill('NOPE');
  await page.getByLabel('Repository folder').fill(makeTempDir());
  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByTestId('project-error')).toContainText('not inside a git repository');
  await app.close();
});

test('settings shows the data folder and versions', async () => {
  const dataDir = makeTempDir();
  const { app, page } = await launchApp(dataDir);
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('data-dir')).toHaveText(dataDir);
  await app.close();
});

test('settings reports the managed OpenCode install', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_OPENCODE_EXE: opencodeStub('2.0.32') });
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('opencode-status')).toHaveText('2.0.32');
  await expect(page.getByRole('button', { name: /Install/ })).toHaveCount(0);
  await app.close();
});

test('settings offers repair when OpenCode does not match the pin', async () => {
  const { app, page } = await launchApp(makeTempDir(), { AIK_OPENCODE_EXE: opencodeStub('1.2.3') });
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('opencode-status')).toHaveText('1.2.3 (expected 2.0.32)');
  await expect(page.getByRole('button', { name: 'Repair install' })).toBeVisible();
  await app.close();
});

test('settings offers the managed install when OpenCode is absent', async () => {
  const { app, page } = await launchApp(makeTempDir());
  await waitReady(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('opencode-status')).toHaveText('not installed');
  await expect(page.getByRole('button', { name: /Install OpenCode/ })).toBeVisible();
  await app.close();
});

test('picks an OpenCode model and answers a test prompt', async () => {
  const exe = resolveOpencodeExe();
  test.skip(!exe, 'no OpenCode binary available (spike copy or managed install)');
  const mock = await startMockLlm([{ content: 'Hello from mock.' }]);
  try {
    const { app, page } = await launchApp(makeTempDir(), { AIK_OPENCODE_EXE: exe!, AIK_OPENCODE_BASE_URL: mock.url });
    await waitReady(page);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByLabel('Default model')).toHaveValue('mock/mock-model', { timeout: 30_000 });
    await page.getByLabel('Test prompt').fill('Say hello.');
    await page.getByRole('button', { name: 'Send test prompt' }).click();
    await expect(page.getByTestId('model-test-reply')).toContainText('Hello from mock.', { timeout: 60_000 });
    await app.close();
  } finally {
    mock.stop();
  }
});
