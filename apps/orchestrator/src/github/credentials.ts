import { Entry } from '@napi-rs/keyring';

export interface GitHubStoredTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope?: string;
  obtainedAt: number; // unix ms
  expiresIn: number; // seconds
  refreshTokenExpiresIn?: number; // seconds
}

export interface CredentialStore {
  saveTokens(userId: number, tokens: GitHubStoredTokens): Promise<void>;
  loadTokens(userId: number): Promise<GitHubStoredTokens | null>;
  deleteTokens(userId: number): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly storage = new Map<number, GitHubStoredTokens>();

  async saveTokens(userId: number, tokens: GitHubStoredTokens): Promise<void> {
    this.storage.set(userId, { ...tokens });
  }

  async loadTokens(userId: number): Promise<GitHubStoredTokens | null> {
    const found = this.storage.get(userId);
    return found ? { ...found } : null;
  }

  async deleteTokens(userId: number): Promise<void> {
    this.storage.delete(userId);
  }
}

export class KeyringCredentialStore implements CredentialStore {
  constructor(private readonly servicePrefix = 'AiKanban/github') {}

  private entry(userId: number): Entry {
    return new Entry(this.servicePrefix, String(userId));
  }

  async saveTokens(userId: number, tokens: GitHubStoredTokens): Promise<void> {
    this.entry(userId).setPassword(JSON.stringify(tokens));
  }

  async loadTokens(userId: number): Promise<GitHubStoredTokens | null> {
    try {
      const raw = this.entry(userId).getPassword();
      if (!raw) return null;
      return JSON.parse(raw) as GitHubStoredTokens;
    } catch {
      return null;
    }
  }

  async deleteTokens(userId: number): Promise<void> {
    try {
      this.entry(userId).deletePassword();
    } catch {
      // Ignore if not present
    }
  }
}

export function createCredentialStore(): CredentialStore {
  if (process.env.NODE_ENV === 'test' || process.env.AIK_CREDENTIAL_STORE === 'memory') {
    return new MemoryCredentialStore();
  }
  return new KeyringCredentialStore();
}
