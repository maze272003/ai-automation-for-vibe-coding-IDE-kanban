import type { AikWindowApi, BridgeResponse } from '@aik/contracts';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../apps/orchestrator/test/helpers/temp.ts';

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

/** Starts the scripted mock LLM (a spike tool, spawned — never imported) and returns its /v1 base URL. */
export async function startMockLlm(turns: { content?: string; status?: number; errorMessage?: string; delayMs?: number }[]): Promise<{ url: string; stop: () => void }> {
  const scenario = path.join(makeTempDir(), 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ turns }));
  const proc = spawn(process.execPath, [path.join(repoRoot, 'spikes', 'shared', 'mock-llm.mjs'), `--scenario=${scenario}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock LLM did not start within 10 s')), 10_000);
    proc.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString().split(/\r?\n/)[0] ?? '');
    });
    proc.once('exit', () => reject(new Error('mock LLM exited before printing its URL')));
  });
  const url = (JSON.parse(line) as { url: string }).url;
  return { url, stop: () => proc.kill() };
}

/** Any available real OpenCode binary for tests that exercise the server: spike copy or the managed install. */
export function resolveOpencodeExe(): string | null {
  const candidates = [
    process.env.AIKA_E2E_OPENCODE_EXE,
    path.join(repoRoot, 'spikes', 'spk-1', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'AiKanban', 'runtime', 'opencode', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
      : null,
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
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
