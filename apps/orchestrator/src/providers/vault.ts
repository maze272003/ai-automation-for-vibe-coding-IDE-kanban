// apps/orchestrator/src/providers/vault.ts — the provider API keys, in the OS credential store.
import { Entry } from '@napi-rs/keyring';

export interface ProviderVault {
  saveKey(providerId: string, key: string): Promise<void>;
  loadKey(providerId: string): Promise<string | null>;
  deleteKey(providerId: string): Promise<void>;
}

export class MemoryProviderVault implements ProviderVault {
  private readonly keys = new Map<string, string>();

  async saveKey(providerId: string, key: string): Promise<void> {
    this.keys.set(providerId, key);
  }

  async loadKey(providerId: string): Promise<string | null> {
    return this.keys.get(providerId) ?? null;
  }

  async deleteKey(providerId: string): Promise<void> {
    this.keys.delete(providerId);
  }
}

export class KeyringProviderVault implements ProviderVault {
  // Per-purpose service name, mirroring `github/credentials.ts` (`AiKanban/github`
  // with the user id as the account): service `AiKanban/provider`, account `<providerId>`.
  constructor(private readonly servicePrefix = 'AiKanban/provider') {}

  private entry(providerId: string): Entry {
    return new Entry(this.servicePrefix, providerId);
  }

  async saveKey(providerId: string, key: string): Promise<void> {
    this.entry(providerId).setPassword(key);
  }

  async loadKey(providerId: string): Promise<string | null> {
    try {
      return this.entry(providerId).getPassword() || null;
    } catch {
      // v1 trade-off: this also swallows real failures (e.g. the store is locked or
      // the user unlock is cancelled), reporting them as "no key" instead of an error.
      // Kept for parity with `KeyringCredentialStore.loadTokens`.
      return null;
    }
  }

  async deleteKey(providerId: string): Promise<void> {
    try {
      this.entry(providerId).deletePassword();
    } catch {
      // Not present — nothing to do.
    }
  }
}

export function createProviderVault(): ProviderVault {
  if (process.env.AIK_CREDENTIAL_STORE === 'memory') {
    return new MemoryProviderVault();
  }
  return new KeyringProviderVault();
}
