// e2e/tests/providers.spec.ts — Task 12 end-to-end verification (plan 2026-10-22-provider-api-keys).
// Connects a custom OpenAI-compatible endpoint (the scripted mock LLM) with a dummy key and walks
// the whole chain: orchestrator registry → credential vault → main-process gateway context
// (refreshed by restartOpencode) → isolated OpenCode server (a virtual provider pointing at the
// loopback gateway) — while the key never reaches the database, a log file or an IPC payload.
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { apiCall, launchApp, makeTempDir, resolveOpencodeExe, startMockLlm, waitReady } from '../fixtures.ts';

const KEY = 'sk-dummy-e2e-key';

/** Providers come back without any key material — these are the fields the tests look at. */
interface ProviderListEntry {
  id: string;
  connected: boolean;
  connectedId: string | null;
  models: { id: string }[];
}

const listProviders = (page: Page) => apiCall<{ providers: ProviderListEntry[] }>(page, 'GET', '/providers');

// A real binary is needed because `restartOpencode` makes the isolated OpenCode server boot
// lazily with the fresh gateway config. Resolution order: AIKA_E2E_OPENCODE_EXE → the fixtures
// resolver (spike copy / managed install) → the vendored copy SPK-5 left behind (exact 2.0.32
// pin, which resolveOpencodeExe does not know). Nothing is installed by this suite.
const vendoredExe = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Temp', 'opencode', 'spk5-cli', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe',
);
const exe =
  process.env.AIKA_E2E_OPENCODE_EXE ?? resolveOpencodeExe() ?? (fs.existsSync(vendoredExe) ? vendoredExe : null);
const SKIP_REASON =
  'no OpenCode binary available (AIKA_E2E_OPENCODE_EXE, spike copy or the vendored SPK-5 copy)';

test('connects a provider and keeps the key off disk and out of the model list', async () => {
  test.skip(!exe, SKIP_REASON);
  const dataDir = makeTempDir();
  const mock = await startMockLlm([{ content: 'OK.' }]);
  try {
    const { app, page } = await launchApp(dataDir, {
      AIK_OPENCODE_EXE: exe!,
      // Credential isolation (PK-8): without this the connect below writes "AiKanban/provider"
      // into the user's real Windows Credential Manager. No other e2e spec sets it, so this
      // suite owns the env (the orchestrator's utility process inherits it through launchApp).
      AIK_CREDENTIAL_STORE: 'memory',
      // Deliberately NOT AIK_OPENCODE_BASE_URL: that would replace the gateway-backed provider
      // fragment in opencode-server.ts and the test would no longer exercise the real gateway.
    });
    await waitReady(page);

    // The catalog is listed.
    const list = await listProviders(page);
    expect(list.status).toBe(200);
    expect(list.body.providers.length).toBeGreaterThan(100);

    // Connect the mock provider as a custom endpoint.
    const connect = await apiCall(page, 'POST', '/providers', {
      providerId: 'custom',
      apiKey: KEY,
      baseUrl: mock.url,
    });
    expect(connect.status).toBe(200);
    expect(JSON.stringify(connect.body)).not.toContain(KEY);

    // It is listed as connected, with the model its /models endpoint advertises.
    const after = await listProviders(page);
    const custom = after.body.providers.find((p) => p.id === 'custom');
    expect(custom?.connected).toBe(true);
    expect(custom?.models.map((m) => m.id)).toContain('mock-model');
    expect(JSON.stringify(after.body)).not.toContain(KEY);

    // The connect flow refreshes the main process's gateway context — restartOpencode is what
    // the Providers card calls right after connecting (it fetches GET /providers into the
    // gateway context and stops the server, which boots lazily with the fresh config).
    await page.evaluate(() => {
      const api = (window as unknown as { api: { restartOpencode: () => Promise<void> } }).api;
      return api.restartOpencode();
    });

    // OpenCode now offers the connected provider's model (virtual provider over the gateway).
    const models = await page.evaluate(async () => {
      const api = (window as unknown as {
        api: { opencodeModels: () => Promise<{ ok: boolean; models?: { providerID: string; id: string }[] }> };
      }).api;
      return api.opencodeModels();
    });
    expect(models.ok).toBe(true);
    expect(models.models?.some((m) => m.id === 'mock-model' && m.providerID?.startsWith('custom-'))).toBe(true);

    // The key is in neither the database nor either persisted log.
    const db = fs.readFileSync(path.join(dataDir, 'app.db')).toString('latin1');
    expect(db).not.toContain(KEY);
    for (const file of ['orchestrator.log', 'orchestrator-stdio.log'] as const) {
      const p = path.join(dataDir, 'logs', file);
      expect(fs.existsSync(p), `${file} exists`).toBe(true);
      expect(fs.readFileSync(p, 'latin1'), `${file} must not contain the key`).not.toContain(KEY);
    }

    await app.close();
  } finally {
    mock.stop();
  }
});

test('round-trips a prompt through the gateway on the connected custom provider', async () => {
  test.skip(!exe, SKIP_REASON);
  const dataDir = makeTempDir();
  const mock = await startMockLlm([{ content: 'OK.' }]);
  try {
    const { app, page } = await launchApp(dataDir, { AIK_OPENCODE_EXE: exe!, AIK_CREDENTIAL_STORE: 'memory' });
    await waitReady(page);

    const connect = await apiCall(page, 'POST', '/providers', {
      providerId: 'custom',
      apiKey: KEY,
      baseUrl: mock.url,
    });
    expect(connect.status).toBe(200);
    const providers = await listProviders(page);
    const providerID = providers.body.providers.find((p) => p.id === 'custom')?.connectedId ?? '';
    expect(providerID.startsWith('custom-')).toBe(true);

    await page.evaluate(() => {
      const api = (window as unknown as { api: { restartOpencode: () => Promise<void> } }).api;
      return api.restartOpencode();
    });

    // The same "Test prompt" the Settings card sends, but against the gateway-backed provider:
    // OpenCode → virtual provider (gateway token) → loopback gateway (injects the vault key) →
    // mock upstream, whose scripted answer comes back unchanged.
    const chat = await page.evaluate(
      async ({ providerID, prompt }) => {
        const api = (window as unknown as {
          api: {
            opencodeChat: (model: { providerID: string; id: string }, prompt: string) => Promise<{
              ok: boolean;
              text?: string;
              error?: string;
            }>;
          };
        }).api;
        return api.opencodeChat({ providerID, id: 'mock-model' }, prompt);
      },
      { providerID, prompt: 'Reply with OK.' },
    );
    expect(chat.ok, chat.error ?? 'the chat did not succeed').toBe(true);
    expect(chat.text ?? '').toContain('OK.');

    await app.close();
  } finally {
    mock.stop();
  }
});
