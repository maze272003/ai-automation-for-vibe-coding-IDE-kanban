// e2e/tests/terminal-panel.spec.ts — Phase 5.3 Task 7 (IDE-5): live ConPTY session,
// exit/restart, and the navigation-kill proof (leaving the Code tab tree-kills the shell).
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { aik, apiCall, launchApp, makeTempDir, makeTempRepo, waitReady } from '../fixtures.ts';

async function openCodeTab(page: Page, repo: string, key: string, name: string) {
  const created = await apiCall(page, 'POST', '/projects', { name, key, repoPath: repo });
  expect(created.status).toBe(201);
  await page.reload();
  await waitReady(page);
  await page.getByTestId(`project-card-${key}`).getByRole('link').click();
  await page.getByTestId('tab-code').click();
  await page.getByTestId('file-explorer').waitFor();
}

/** Clicks the terminal (to focus xterm's hidden textarea) and runs one command. */
async function runInTerminal(page: Page, command: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('terminal panel: live ConPTY session, exit and restart', async () => {
  const repo = makeTempRepo({ name: 'terminal-e2e' });
  const dataDir = makeTempDir('aikanban-e2e-terminal-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'TERM', 'Terminal E2E');

    await page.getByTestId('code-terminal-toggle').click();
    await expect(page.getByTestId('code-terminal-panel')).toBeVisible();
    await expect(page.getByTestId('code-terminal-notice')).toContainText('Windows user rights');

    const xterm = page.locator('.xterm');
    await xterm.waitFor({ state: 'visible', timeout: 30_000 }); // ConPTY spawn can be slow
    await runInTerminal(page, 'echo aik-terminal-7431');
    await expect(xterm).toContainText('aik-terminal-7431', { timeout: 20_000 });

    await runInTerminal(page, 'exit');
    const exited = page.getByTestId('code-terminal-exited');
    // node-pty flushes the exit event ~1 s after the last output; CI can be slower.
    await expect(exited).toBeVisible({ timeout: 40_000 });
    await expect(exited).toContainText('exit code');

    await page.getByTestId('code-terminal-restart').click();
    await xterm.waitFor({ state: 'visible', timeout: 30_000 });
    await runInTerminal(page, 'echo aik-terminal-after-restart');
    await expect(xterm).toContainText('aik-terminal-after-restart', { timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test('terminal panel: leaving the Code tab closes the session', async () => {
  const repo = makeTempRepo({ name: 'terminal-e2e-2' });
  const dataDir = makeTempDir('aikanban-e2e-terminal2-');
  const { app, page } = await launchApp(dataDir);
  try {
    await waitReady(page);
    await openCodeTab(page, repo, 'TERM2', 'Terminal E2E 2');

    await page.getByTestId('code-terminal-toggle').click();
    const xterm = page.locator('.xterm');
    await xterm.waitFor({ state: 'visible', timeout: 30_000 });
    await runInTerminal(page, 'echo keepalive');
    await expect(xterm).toContainText('keepalive', { timeout: 20_000 });

    // A real session must exist before navigating away; its pid is the inner cmd.exe.
    const before = await aik(app, (h) => h.terminalSessions());
    expect(before.length).toBeGreaterThanOrEqual(1);
    const pid = before[0]!.pid;

    await page.getByTestId('tab-git').click();
    // We made no edits, so the unsaved-changes guard should not appear — but resolve
    // it if it does, so the navigation always completes.
    const guard = page.getByRole('heading', { name: 'Leave with unsaved changes?' });
    if (await guard.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
      await page.getByTestId('code-leave-confirm').click();
    }
    await expect(page.getByTestId('git-toolbar')).toBeVisible();
    await expect(page.getByTestId('code-terminal-panel')).toHaveCount(0);

    // Panel unmount closes the session; desktop main tree-kills the shell. Poll
    // tasklist from the test runner until that cmd.exe pid disappears.
    const deadline = Date.now() + 15_000;
    let gone = false;
    while (Date.now() < deadline) {
      const listed = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV'], { encoding: 'utf8' });
      if (!(listed.stdout ?? '').includes(`"${pid}"`)) {
        gone = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    expect(gone, `shell pid ${pid} should be gone after leaving the Code tab`).toBe(true);

    // Returning to Code opens a fresh session that actually works.
    await page.getByTestId('tab-code').click();
    await page.getByTestId('file-explorer').waitFor();
    await page.getByTestId('code-terminal-toggle').click();
    await xterm.waitFor({ state: 'visible', timeout: 30_000 });
    await runInTerminal(page, 'echo fresh-session');
    await expect(xterm).toContainText('fresh-session', { timeout: 20_000 });
  } finally {
    await app.close();
  }
});
