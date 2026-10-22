import { appSettings, githubConnections } from '@aik/db';
import { eq } from 'drizzle-orm';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCredentialStore } from '../src/github/credentials.ts';
import { GitHubAuthService } from '../src/github/service.ts';
import { createTestDb } from './helpers/db.ts';

describe('GitHubAuthService', () => {
  let dbHolder: ReturnType<typeof createTestDb>;
  let mockServer: http.Server;
  let mockPort: number;
  let service: GitHubAuthService;
  let credentialStore: MemoryCredentialStore;
  let pollAttempts = 0;

  beforeAll(async () => {
    dbHolder = createTestDb();
    credentialStore = new MemoryCredentialStore();

    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'POST' && url.pathname === '/login/device/code') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            device_code: 'dev_code_12345',
            user_code: 'WDJB-MJHT',
            verification_uri: 'http://localhost/login/device',
            expires_in: 900,
            interval: 1,
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const grantType = params.get('grant_type');

          if (grantType === 'refresh_token') {
            const refreshToken = params.get('refresh_token');
            if (refreshToken === 'valid_refresh_token') {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  access_token: 'ghu_refreshed_access_token',
                  refresh_token: 'ghr_new_refresh_token',
                  token_type: 'bearer',
                  expires_in: 28800,
                  refresh_token_expires_in: 15552000,
                }),
              );
            } else {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_refresh_token' }));
            }
            return;
          }

          pollAttempts += 1;
          if (pollAttempts === 1) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'authorization_pending' }));
            return;
          }
          if (pollAttempts === 2) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'slow_down' }));
            return;
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'ghu_access_token_abc123',
              refresh_token: 'valid_refresh_token',
              token_type: 'bearer',
              scope: 'repo',
              expires_in: 28800,
              refresh_token_expires_in: 15552000,
            }),
          );
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/user') {
        if (req.headers.authorization === 'Bearer ghu_access_token_abc123') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 583231, login: 'octocat' }));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    mockPort = (mockServer.address() as AddressInfo).port;

    service = new GitHubAuthService({
      db: dbHolder.db,
      credentials: credentialStore,
      now: () => 1_700_000_000_000,
      githubBaseUrl: `http://127.0.0.1:${mockPort}`,
      apiBaseUrl: `http://127.0.0.1:${mockPort}`,
    });
  });

  afterAll(() => {
    mockServer.close();
    dbHolder.close();
  });

  it('manages client ID in app_settings', async () => {
    expect(await service.getSettings()).toEqual({ clientId: null });

    await service.setClientId('Iv1.1234567890abcdef');
    expect(await service.getSettings()).toEqual({ clientId: 'Iv1.1234567890abcdef' });

    const row = dbHolder.db.select().from(appSettings).where(eq(appSettings.key, 'github_app_client_id')).get();
    expect(row).toBeDefined();
    expect(row?.value).toBe('Iv1.1234567890abcdef');
  });

  it('completes device code flow: start -> pending -> slow_down -> complete', async () => {
    pollAttempts = 0;
    const start = await service.startDeviceFlow();
    expect(start.userCode).toBe('WDJB-MJHT');
    expect(start.verificationUri).toBe('http://localhost/login/device');
    expect(start.sessionToken).toBeTruthy();

    const p1 = await service.pollDeviceFlow(start.sessionToken);
    expect(p1.status).toBe('pending');

    const p2 = await service.pollDeviceFlow(start.sessionToken);
    expect(p2.status).toBe('slow_down');
    expect(p2.interval).toBe(6); // 1s + 5s on slow_down

    const p3 = await service.pollDeviceFlow(start.sessionToken);
    expect(p3.status).toBe('complete');
    expect(p3.connection?.login).toBe('octocat');
    expect(p3.connection?.status).toBe('connected');

    // Verify token was stored in credential store
    const tokens = await credentialStore.loadTokens(583231);
    expect(tokens?.accessToken).toBe('ghu_access_token_abc123');
    expect(tokens?.refreshToken).toBe('valid_refresh_token');

    // Verify database does NOT store the tokens
    const dbRows = dbHolder.db.select().from(githubConnections).all();
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0]?.login).toBe('octocat');
    expect(JSON.stringify(dbRows[0])).not.toContain('ghu_access_token_abc123');
    expect(JSON.stringify(dbRows[0])).not.toContain('valid_refresh_token');
  });

  it('proactively refreshes tokens', async () => {
    const refreshed = await service.refreshToken();
    expect(refreshed).toBe(true);

    const tokens = await credentialStore.loadTokens(583231);
    expect(tokens?.accessToken).toBe('ghu_refreshed_access_token');
    expect(tokens?.refreshToken).toBe('ghr_new_refresh_token');
  });

  it('disconnects and deletes credentials', async () => {
    await service.disconnect();

    const conn = await service.getConnection();
    expect(conn?.status).toBe('disconnected');

    const tokens = await credentialStore.loadTokens(583231);
    expect(tokens).toBeNull();
  });
});
