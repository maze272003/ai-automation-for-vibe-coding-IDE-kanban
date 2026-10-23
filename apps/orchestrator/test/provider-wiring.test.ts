// apps/orchestrator/test/provider-wiring.test.ts — Task 9 wiring checks for the orchestrator
// side: the gateway exists iff a per-run gateway token was passed (managed mode only), the
// provider routes ride on the same API server, the gateway token and the orchestrator API
// token are mutually rejected, and shutdown closes the gateway with everything else.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startOrchestrator, type OrchestratorOptions } from '../src/app.ts';
import { ProviderService } from '../src/providers/service.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { MIGRATIONS, createTestDb } from './helpers/db.ts';
import { makeTempDir } from './helpers/temp.ts';

const apiToken = 'z'.repeat(43);

function opts(dataDir: string, overrides: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  return {
    dataDir,
    token: apiToken,
    migrationsFolder: MIGRATIONS,
    versions: { app: '0.1.0', electron: null },
    ...overrides,
  };
}

/** A bare gateway probe that touches neither a provider nor the upstream. */
function gatewayPost(port: number, token: string | null): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/chat/completions`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: '{}',
  });
}

describe('orchestrator provider wiring', () => {
  it('starts the gateway only when a per-run gateway token is passed, wired to vault + routes', async () => {
    const dataDir = makeTempDir();
    const gatewayToken = crypto.randomBytes(32).toString('base64url');
    const managed = await startOrchestrator(opts(dataDir, { gatewayToken }));

    expect(managed.gatewayPort).not.toBeNull();
    expect(managed.gatewayPort).not.toBe(managed.port);
    const gatewayPort = managed.gatewayPort as number;

    // Managed mode registers the root-relative provider routes.
    const providers = await fetch(`http://127.0.0.1:${managed.port}/providers`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(providers.status).toBe(200);
    const body = (await providers.json()) as { providers: unknown[] };
    expect(body.providers.length).toBeGreaterThan(100);

    // The two tokens have different powers (plan Global Constraints): each is rejected by the other's server.
    const apiRejectsGatewayToken = await fetch(`http://127.0.0.1:${managed.port}/providers`, {
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect(apiRejectsGatewayToken.status).toBe(401);

    const gatewayRejectsApiToken = await gatewayPost(gatewayPort, apiToken);
    expect(gatewayRejectsApiToken.status).toBe(401);
    expect(((await gatewayRejectsApiToken.json()) as { error: { message: string } }).error.message).toContain('gateway token');

    // The correct gateway token passes auth and reaches the empty provider source (nothing connected yet).
    const gatewayOk = await gatewayPost(gatewayPort, gatewayToken);
    expect(gatewayOk.status).toBe(401);
    expect(((await gatewayOk.json()) as { error: { code?: string } }).error.code).toBe('PROVIDER_NOT_CONNECTED');

    await managed.close();

    // Closing the orchestrator closes the gateway with it — the port stops answering.
    await expect(gatewayPost(gatewayPort, gatewayToken)).rejects.toThrow();
  });

  it('starts no gateway and registers no provider routes in personal mode (no gateway token)', async () => {
    const dataDir = makeTempDir();
    const personal = await startOrchestrator(opts(dataDir));
    expect(personal.gatewayPort).toBeNull();
    const providers = await fetch(`http://127.0.0.1:${personal.port}/providers`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(providers.status).toBe(404);
    await personal.close();
  });
});

describe('ProviderService gateway lookups (GatewayProviderSource)', () => {
  it('findConnected and findByModel resolve connected providers only', async () => {
    const t = createTestDb();
    const service = new ProviderService({ db: t.db, vault: new MemoryProviderVault(), now: () => 1_700_000_000_000 });
    expect(service.findConnected('openai')).toBeNull();
    expect(service.findByModel('gpt-4o')).toBeNull();

    await service.connect({ providerId: 'openai', apiKey: 'sk-wiring-test' });
    const connected = service.getConnected().find((p) => p.id === 'openai');
    expect(connected?.modelIds.length).toBeGreaterThan(0);
    expect(service.findConnected('openai')).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      auth: 'bearer',
      modelIds: connected?.modelIds,
    });
    expect(service.findByModel(connected?.modelIds[0] ?? 'gpt-4o')?.id).toBe('openai');
    expect(service.findConnected('not-connected')).toBeNull();
    t.close();
  });
});
