// apps/orchestrator/test/api-security.test.ts
import crypto from 'node:crypto';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mutation, parse } from '../src/api/idempotency.ts';
import { createApiServer } from '../src/api/server.ts';
import { registerHealthRoutes } from '../src/api/routes/health.ts';
import { createTestDb } from './helpers/db.ts';

const TOKEN = 'a'.repeat(43);
const PORT = 41234;
let t: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiServer>;
let counter = 0;

beforeEach(async () => {
  t = createTestDb();
  counter = 0;
  app = createApiServer({ token: TOKEN, getPort: () => PORT });
  registerHealthRoutes(app, { db: t.db, versions: { app: '0.1.0', electron: null, node: process.version }, dataDir: t.dir });
  mutation(app, { db: t.db, now: () => 1 }, 'POST', '/test/echo', async (req) => {
    const body = parse(z.object({ value: z.string().min(1) }).strict(), req.body);
    counter += 1;
    return { status: 201, body: { value: body.value, counter } };
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  t.close();
});

const headers = (extra: Record<string, string> = {}) => ({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...extra });

describe('security hook', () => {
  it('serves health to an authenticated loopback request', async () => {
    const r = await app.inject({ method: 'GET', url: '/health', headers: headers() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', components: { db: 'ok' }, versions: { app: '0.1.0', opencode: null } });
  });
  it('rejects a missing or wrong token with 401', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/health', headers: { host: `127.0.0.1:${PORT}` } });
    const r2 = await app.inject({ method: 'GET', url: '/health', headers: headers({ authorization: `Bearer ${'b'.repeat(43)}` }) });
    expect([r1.statusCode, r2.statusCode]).toEqual([401, 401]);
    expect(r1.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token', retryable: false } });
  });
  it('rejects foreign Host headers (DNS rebinding) with 403', async () => {
    for (const host of ['evil.example', `127.0.0.1.nip.io:${PORT}`, `127.0.0.1:${PORT + 1}`]) {
      const r = await app.inject({ method: 'GET', url: '/health', headers: headers({ host }) });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('FORBIDDEN_ORIGIN');
    }
  });
  it('accepts localhost and the app origin, rejects other origins', async () => {
    expect((await app.inject({ method: 'GET', url: '/health', headers: headers({ host: `localhost:${PORT}`, origin: 'app://ui' }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health', headers: headers({ origin: 'https://evil.example' }) })).statusCode).toBe(403);
  });
  it('returns the envelope for unknown routes', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope', headers: headers() });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});

describe('mutations', () => {
  const post = (payload: unknown, key?: string) =>
    app.inject({ method: 'POST', url: '/test/echo', headers: headers(key ? { 'idempotency-key': key } : {}), payload: payload as object });

  it('require an Idempotency-Key', async () => {
    const r = await post({ value: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_FAILED');
  });
  it('replay the stored response for a repeated key without re-running the handler', async () => {
    const key = crypto.randomUUID();
    const a = await post({ value: 'x' }, key);
    const b = await post({ value: 'x' }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(counter).toBe(1);
  });
  it('reject a reused key with a different body (422)', async () => {
    const key = crypto.randomUUID();
    await post({ value: 'x' }, key);
    const r = await post({ value: 'y' }, key);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
  it('validate bodies with details', async () => {
    const r = await post({ value: '' }, crypto.randomUUID());
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
    expect(Array.isArray(r.json().error.details)).toBe(true);
  });
});

describe('binding', () => {
  it('is not reachable on non-loopback interfaces', async () => {
    let port = 0;
    const live = createApiServer({ token: TOKEN, getPort: () => port });
    await live.listen({ host: '127.0.0.1', port: 0 });
    port = (live.server.address() as AddressInfo).port;
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      await expect(fetch(`http://${external.address}:${port}/health`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
    }
    await live.close();
  });
});
