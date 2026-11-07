import { defineConfig } from 'vitest/config';
if (process.env.AIK_LIVE_AGENTS !== '1') {
  throw new Error('live agent suite is opt-in: set AIK_LIVE_AGENTS=1');
}
export default defineConfig({ test: { include: ['apps/orchestrator/test/live/**/*.live.test.ts'] } });
