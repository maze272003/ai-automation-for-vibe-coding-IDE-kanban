import type { AikWindowApi, BridgeResponse } from '@aik/contracts';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

export { makeTempDir, makeTempRepo } from '../apps/orchestrator/test/helpers/temp.ts';
export const repoRoot = path.resolve(import.meta.dirname, '..');
export const distDir = path.join(repoRoot, 'apps', 'desktop', 'dist');

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

export async function launchApp(dataDir: string, env: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({
    args: [distDir],
    env: { ...(process.env as Record<string, string>), AIK_DATA_DIR: dataDir, AIK_E2E: '1', ...env },
  });
  const page = await app.firstWindow();
  return { app, page };
}

export async function waitReady(page: Page): Promise<void> {
  await page.getByTestId('app-ready').waitFor({ state: 'attached', timeout: 60_000 });
}

/** Calls the orchestrator through the same bridge the UI uses. */
export function apiCall<T = unknown>(page: Page, method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown): Promise<BridgeResponse & { body: T }> {
  return page.evaluate(
    ([m, url, b]) => {
      const api = (window as unknown as { api: AikWindowApi }).api;
      return api.request(m, url, b, m === 'GET' ? undefined : crypto.randomUUID());
    },
    [method, p, body] as const,
  ) as Promise<BridgeResponse & { body: T }>;
}

/** Main-process test hook, present only when AIK_E2E=1. */
export function aik<T>(app: ElectronApplication, fn: (h: { supervisor: { state: string; port: number | null; child: { pid: number | undefined } | null }; token: string; dataDir: string }) => T): Promise<T> {
  return app.evaluate((_electron, f) => {
    const hook = (globalThis as unknown as { __aik: Parameters<typeof fn>[0] }).__aik;
    return new Function('h', `return (${f})(h)`)(hook) as T;
  }, fn.toString());
}
