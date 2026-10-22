import {
  type GitHubConnectionDTO,
  type GitHubSettingsDTO,
  type DeviceCodeStartDTO,
  type DeviceFlowPollDTO,
  GitHubClientIdSchema,
} from '@aik/contracts';
import { appSettings, githubConnections, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { systemClock, type Clock } from '../time.ts';
import type { CredentialStore } from './credentials.ts';

const CLIENT_ID_SETTING_KEY = 'github_app_client_id';

interface DeviceSession {
  clientId: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
}

export interface GitHubAuthServiceOptions {
  db: AikDb;
  credentials: CredentialStore;
  now?: Clock;
  githubBaseUrl?: string;
  apiBaseUrl?: string;
}

export class GitHubAuthService {
  private readonly db: AikDb;
  private readonly credentials: CredentialStore;
  private readonly now: Clock;
  private readonly githubBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly sessions = new Map<string, DeviceSession>();

  constructor(opts: GitHubAuthServiceOptions) {
    this.db = opts.db;
    this.credentials = opts.credentials;
    this.now = opts.now ?? systemClock;
    this.githubBaseUrl = opts.githubBaseUrl ?? 'https://github.com';
    this.apiBaseUrl = opts.apiBaseUrl ?? 'https://api.github.com';
  }

  private nowDate(): Date {
    return new Date(this.now());
  }

  async getSettings(): Promise<GitHubSettingsDTO> {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, CLIENT_ID_SETTING_KEY)).get();
    return {
      clientId: row ? (row.value as string) : null,
    };
  }

  async setClientId(clientId: string): Promise<GitHubSettingsDTO> {
    const validated = GitHubClientIdSchema.parse(clientId);
    const ts = this.nowDate();
    this.db
      .insert(appSettings)
      .values({ key: CLIENT_ID_SETTING_KEY, value: validated, updatedAt: ts })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: validated, updatedAt: ts },
      })
      .run();
    return { clientId: validated };
  }

  async getConnection(): Promise<GitHubConnectionDTO | null> {
    const row = this.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.status, 'connected'))
      .get();
    if (!row) {
      const anyRow = this.db.select().from(githubConnections).get();
      if (!anyRow) return null;
      return this.toDTO(anyRow);
    }
    return this.toDTO(row);
  }

  private toDTO(row: typeof githubConnections.$inferSelect): GitHubConnectionDTO {
    return {
      id: row.id,
      githubUserId: row.githubUserId,
      login: row.login,
      appClientId: row.appClientId,
      status: row.status as GitHubConnectionDTO['status'],
      accessExpiresAt: row.accessExpiresAt ? row.accessExpiresAt.toISOString() : null,
      refreshExpiresAt: row.refreshExpiresAt ? row.refreshExpiresAt.toISOString() : null,
      grantedPermissions: row.grantedPermissions ?? null,
      lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    };
  }

  async startDeviceFlow(): Promise<DeviceCodeStartDTO> {
    const settings = await this.getSettings();
    if (!settings.clientId) {
      throw new Error('CLIENT_ID_NOT_CONFIGURED');
    }

    const res = await fetch(`${this.githubBaseUrl}/login/device/code`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: settings.clientId,
        scope: 'repo,read:org,read:user',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Device code request failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    const sessionToken = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sessionToken, {
      clientId: settings.clientId,
      deviceCode: data.device_code,
      interval: data.interval ?? 5,
      expiresAt: this.now() + (data.expires_in ?? 900) * 1000,
    });

    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in ?? 900,
      interval: data.interval ?? 5,
      sessionToken,
    };
  }

  async pollDeviceFlow(sessionToken: string): Promise<DeviceFlowPollDTO> {
    const session = this.sessions.get(sessionToken);
    if (!session || this.now() > session.expiresAt) {
      this.sessions.delete(sessionToken);
      return { status: 'expired', error: 'Verification session expired' };
    }

    const res = await fetch(`${this.githubBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: session.clientId,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      if (data.error === 'authorization_pending') {
        return { status: 'pending', interval: session.interval };
      }
      if (data.error === 'slow_down') {
        session.interval += 5;
        return { status: 'slow_down', interval: session.interval };
      }
      if (data.error === 'access_denied') {
        this.sessions.delete(sessionToken);
        return { status: 'access_denied', error: data.error_description ?? 'Access denied' };
      }
      if (data.error === 'expired_token') {
        this.sessions.delete(sessionToken);
        return { status: 'expired', error: data.error_description ?? 'Code expired' };
      }
      return { status: 'error', error: data.error_description ?? data.error };
    }

    if (!data.access_token) {
      return { status: 'error', error: 'No access token in response' };
    }

    // Success: fetch user profile
    const userRes = await fetch(`${this.apiBaseUrl}/user`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${data.access_token}`,
        'user-agent': 'AI-Kanban',
      },
    });

    if (!userRes.ok) {
      return { status: 'error', error: `Failed to load GitHub user info (${userRes.status})` };
    }

    const user = (await userRes.json()) as { id: number; login: string };
    const nowMs = this.now();
    const ts = this.nowDate();
    const accessExpiresAt = data.expires_in ? new Date(nowMs + data.expires_in * 1000) : null;
    const refreshExpiresAt = data.refresh_token_expires_in
      ? new Date(nowMs + data.refresh_token_expires_in * 1000)
      : null;

    // Save tokens in credential store (never in db)
    await this.credentials.saveTokens(user.id, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      tokenType: data.token_type ?? 'bearer',
      scope: data.scope,
      obtainedAt: nowMs,
      expiresIn: data.expires_in ?? 28800,
      refreshTokenExpiresIn: data.refresh_token_expires_in,
    });

    // Save metadata in database
    const tokenRef = `AiKanban/github/${user.id}`;
    const row = this.db
      .insert(githubConnections)
      .values({
        githubUserId: user.id,
        login: user.login,
        appClientId: session.clientId,
        tokenRef,
        accessExpiresAt,
        refreshExpiresAt,
        status: 'connected',
        lastValidatedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: githubConnections.githubUserId,
        set: {
          login: user.login,
          appClientId: session.clientId,
          tokenRef,
          accessExpiresAt,
          refreshExpiresAt,
          status: 'connected',
          lastValidatedAt: ts,
          updatedAt: ts,
        },
      })
      .returning()
      .get();

    this.sessions.delete(sessionToken);
    return {
      status: 'complete',
      connection: this.toDTO(row),
    };
  }

  async refreshToken(): Promise<boolean> {
    const conn = this.db.select().from(githubConnections).where(eq(githubConnections.status, 'connected')).get();
    if (!conn) return false;

    const stored = await this.credentials.loadTokens(conn.githubUserId);
    if (!stored || !stored.refreshToken) {
      this.db.update(githubConnections).set({ status: 'expired', updatedAt: this.nowDate() }).where(eq(githubConnections.id, conn.id)).run();
      return false;
    }

    const res = await fetch(`${this.githubBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: conn.appClientId,
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
      }),
    });

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      error?: string;
    };

    if (data.error || !data.access_token) {
      this.db.update(githubConnections).set({ status: 'expired', updatedAt: this.nowDate() }).where(eq(githubConnections.id, conn.id)).run();
      return false;
    }

    const nowMs = this.now();
    const ts = this.nowDate();
    await this.credentials.saveTokens(conn.githubUserId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? stored.refreshToken,
      tokenType: data.token_type ?? stored.tokenType,
      scope: stored.scope,
      obtainedAt: nowMs,
      expiresIn: data.expires_in ?? stored.expiresIn,
      refreshTokenExpiresIn: data.refresh_token_expires_in ?? stored.refreshTokenExpiresIn,
    });

    const accessExpiresAt = data.expires_in ? new Date(nowMs + data.expires_in * 1000) : null;
    const refreshExpiresAt = data.refresh_token_expires_in ? new Date(nowMs + data.refresh_token_expires_in * 1000) : null;

    this.db
      .update(githubConnections)
      .set({
        accessExpiresAt,
        refreshExpiresAt,
        lastValidatedAt: ts,
        updatedAt: ts,
      })
      .where(eq(githubConnections.id, conn.id))
      .run();

    return true;
  }

  async disconnect(): Promise<void> {
    const conn = this.db.select().from(githubConnections).get();
    if (conn) {
      await this.credentials.deleteTokens(conn.githubUserId);
      this.db
        .update(githubConnections)
        .set({ status: 'disconnected', updatedAt: this.nowDate() })
        .where(eq(githubConnections.id, conn.id))
        .run();
    }
  }
}
