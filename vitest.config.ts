import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'apps/orchestrator/test/live/**'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
