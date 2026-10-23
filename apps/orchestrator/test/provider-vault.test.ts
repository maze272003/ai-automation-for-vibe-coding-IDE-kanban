import { describe, expect, it } from 'vitest';
import { MemoryProviderVault } from '../src/providers/vault.ts';

describe('MemoryProviderVault', () => {
  it('saves, loads and deletes a key per provider', async () => {
    const vault = new MemoryProviderVault();
    await vault.saveKey('zai', 'sk-dummy-zai');
    await vault.saveKey('anthropic', 'sk-dummy-anthropic');
    expect(await vault.loadKey('zai')).toBe('sk-dummy-zai');
    expect(await vault.loadKey('anthropic')).toBe('sk-dummy-anthropic');
    expect(await vault.loadKey('groq')).toBeNull();
    await vault.deleteKey('zai');
    expect(await vault.loadKey('zai')).toBeNull();
    expect(await vault.loadKey('anthropic')).toBe('sk-dummy-anthropic');
  });

  it('replaces a key instead of appending', async () => {
    const vault = new MemoryProviderVault();
    await vault.saveKey('zai', 'first');
    await vault.saveKey('zai', 'second');
    expect(await vault.loadKey('zai')).toBe('second');
  });
});
