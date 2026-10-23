import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.ts';
import { registerProviderRoutes } from '../src/api/routes/providers.ts';
import { ProviderService } from '../src/providers/service.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createTestDb } from './helpers/db.ts';

const TOKEN = 'k'.repeat(43);
const PORT = 41237;

async function build() {
  const t = createTestDb();
  const vault = new MemoryProviderVault();
  const providers = new ProviderService({ db: t.db, vault, now: () => 1_700_000_000_000 });
  const app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerProviderRoutes(app, { providers, now: () => 1_700_000_000_000 });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      payload,
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) },
    });
  return { t, vault, providers, call };
}

describe('the provider routes', () => {
  it('lists the catalog with no key material', async () => {
    const { call } = await build();
    const res = await call('GET', '/providers');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: { id: string }[] };
    expect(body.providers.length).toBeGreaterThan(100);
    expect(res.body).not.toMatch(/sk-/);
  });

  it('connects a provider and never returns the key', async () => {
    const { call, vault } = await build();
    const res = await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy-secret' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-dummy-secret');
    expect(await vault.loadKey('openai')).toBe('sk-dummy-secret');
  });

  it('rejects an unknown provider with 400', async () => {
    const { call } = await build();
    const res = await call('POST', '/providers', { providerId: 'nope', apiKey: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('removes a provider', async () => {
    const { call, vault } = await build();
    await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy' });
    const res = await call('DELETE', '/providers/openai');
    expect(res.statusCode).toBe(200);
    expect(await vault.loadKey('openai')).toBeNull();
  });

  it('stores and reads the default model', async () => {
    const { call } = await build();
    await call('POST', '/providers', { providerId: 'openai', apiKey: 'sk-dummy' });
    const put = await call('PUT', '/settings/default-model', { providerId: 'openai', modelId: 'gpt-4o' });
    expect(put.statusCode).toBe(200);
    const get = await call('GET', '/settings/default-model');
    expect(get.json()).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });
});
