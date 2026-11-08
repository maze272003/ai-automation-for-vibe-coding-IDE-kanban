import { expect, test } from '@playwright/test';
import { apiCall, launchApp, makeTempDir, waitReady } from '../fixtures.ts';

test('Usage shows recorded dollars, a project picker and an honest subtitle', async () => {
  const launched = await launchApp(makeTempDir());
  try {
    const { page } = launched;
    await waitReady(page);
    const response = await apiCall(page, 'POST', '/metrics/usage/probe', {
      providerId: 'custom', modelId: 'test', durationMs: 50,
      usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0, assistantMessages: 1, reportedCostUsd: 0.12 },
    });
    expect(response.status).toBe(201);
    await page.getByRole('link', { name: 'Usage', exact: true }).click();
    await expect(page.getByTestId('usage-cost')).toContainText('$0.12');
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible();
    await expect(page.getByText('(REL-5)', { exact: false })).toHaveCount(0);
  } finally { await launched.app.close(); }
});
