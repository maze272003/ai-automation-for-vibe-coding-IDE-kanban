import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Generous budgets: each test launches a full Electron app, and local runs on busy
  // developer machines otherwise false-fail while the OS starves process startup.
  timeout: 150_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
});
