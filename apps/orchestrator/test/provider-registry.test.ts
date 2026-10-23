import { describe, expect, it } from 'vitest';
import { modelProfiles, providers } from '@aik/db';
import { ProviderService } from '../src/providers/service.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createTestDb } from './helpers/db.ts';

const now = () => 1_700_000_000_000;

function service(overrides: Partial<ConstructorParameters<typeof ProviderService>[0]> = {}) {
  const t = createTestDb();
  const vault = new MemoryProviderVault();
  const s = new ProviderService({ db: t.db, vault, now, ...overrides });
  return { t, vault, s };
}

describe('ProviderService', () => {
  it('connects a catalog provider: vault entry, provider row and model rows', async () => {
    const { t, vault, s } = service();
    const dto = await s.connect({ providerId: 'openai', apiKey: 'sk-dummy-openai' });
    expect(dto.connected).toBe(true);
    expect(dto.id).toBe('openai');
    expect(await vault.loadKey('openai')).toBe('sk-dummy-openai');

    const rows = t.db.select().from(providers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyRef).toBe('keyring:provider/openai');
    expect(rows[0]!.baseUrl).toBe('https://api.openai.com/v1');
    const models = t.db.select().from(modelProfiles).all();
    expect(models.length).toBeGreaterThan(0);
  });

  it('never returns key material in the DTO', async () => {
    const { s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy-openai' });
    expect(JSON.stringify(s.list())).not.toContain('sk-dummy-openai');
  });

  it('rejects an unknown provider and a missing key', async () => {
    const { s } = service();
    await expect(s.connect({ providerId: 'not-a-provider', apiKey: 'x' })).rejects.toThrow(/unknown provider/i);
    await expect(s.connect({ providerId: 'openai' })).rejects.toThrow(/api key/i);
  });

  it('replaces the key and the rows when a provider is connected twice', async () => {
    const { t, vault, s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-first' });
    await s.connect({ providerId: 'openai', apiKey: 'sk-second' });
    expect(await vault.loadKey('openai')).toBe('sk-second');
    expect(t.db.select().from(providers).all()).toHaveLength(1);
  });

  it('removes a provider: vault entry, rows and the default model', async () => {
    const { t, vault, s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy' });
    s.setDefaultModel({ providerId: 'openai', modelId: 'gpt-4o' });
    s.remove('openai');
    expect(await vault.loadKey('openai')).toBeNull();
    expect(t.db.select().from(providers).all()).toHaveLength(0);
    expect(t.db.select().from(modelProfiles).all()).toHaveLength(0);
    expect(s.getDefaultModel()).toBeNull();
  });

  it('gives each custom endpoint its own id and discovers its models', async () => {
    const { s } = service({ discoverModels: async () => ['my-model-a', 'my-model-b'] });
    const a = await s.connect({ providerId: 'custom', apiKey: 'sk-dummy', baseUrl: 'http://127.0.0.1:1234/v1' });
    const b = await s.connect({ providerId: 'custom', apiKey: 'sk-dummy', baseUrl: 'http://127.0.0.1:5678/v1' });
    expect(a.connectedId).not.toBe(b.connectedId);
    expect(a.connectedId?.startsWith('custom-')).toBe(true);
    expect(s.getConnected().find((p) => p.id === a.connectedId)?.modelIds).toEqual(['my-model-a', 'my-model-b']);
  });

  it('stores and clears the default model', async () => {
    const { s } = service();
    await s.connect({ providerId: 'openai', apiKey: 'sk-dummy' });
    s.setDefaultModel({ providerId: 'openai', modelId: 'gpt-4o' });
    expect(s.getDefaultModel()).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
    s.setDefaultModel(null);
    expect(s.getDefaultModel()).toBeNull();
  });
});
