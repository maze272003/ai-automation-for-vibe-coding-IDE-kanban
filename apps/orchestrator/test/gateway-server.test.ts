import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startGateway, type RunningGateway } from '../src/gateway/server.ts';
import { MemoryProviderVault } from '../src/providers/vault.ts';
import { createRedactor } from '../src/secrets/redactor.ts';
import { parseProviderFailure } from '@aik/contracts';

interface Upstream { url: string; calls: { path: string; query: string; headers: http.IncomingHttpHeaders; body: string }[]; close(): void; }

async function startUpstream(handler: (body: string) => { status: number; body: string; contentType?: string }): Promise<Upstream> {
  const calls: Upstream['calls'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', query: '', headers: req.headers, body: raw });
      const out = handler(raw);
      res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => server.close() };
}

const providers = (baseUrl: string, modelIds: string[]) => ({
  findConnected: (id: string) => (id === 'mock' ? { baseUrl, auth: 'bearer' as const, modelIds } : null),
  findByModel: (modelId: string) => (modelIds.includes(modelId) ? { id: 'mock', baseUrl, auth: 'bearer' as const, modelIds } : null),
  markQuotaExhausted: () => undefined,
});

let gateway: RunningGateway | null = null;
afterEach(async () => {
  await gateway?.close();
  gateway = null;
});

describe('the model gateway', () => {
  it('injects the provider key and strips the local token', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const vault = new MemoryProviderVault();
    await vault.saveKey('mock', 'sk-real-key');
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault,
      redact: createRedactor().redact,
    });

    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(res.status).toBe(200);
    const [upstreamCall] = upstream.calls;
    expect(upstreamCall).toBeDefined();
    expect(upstreamCall?.headers.authorization).toBe('Bearer sk-real-key');
    expect(upstreamCall?.path).toBe('/v1/chat/completions');
    upstream.close();
  });

  it('rejects a request without the gateway token and never calls the upstream', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: '{}' }));
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    upstream.close();
  });

  it('rejects a provider that is not connected', async () => {
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers('http://127.0.0.1:1/v1', ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'not-connected' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a model that does not belong to the named provider', async () => {
    const upstream = await startUpstream(() => ({ status: 200, body: '{}' }));
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault: new MemoryProviderVault(),
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock' },
      body: JSON.stringify({ model: 'not-mine' }),
    });
    expect(res.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
    upstream.close();
  });

  it('passes an upstream error status through with a parseable marker', async () => {
    const upstream = await startUpstream(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }));
    // A key must exist for the request to reach the upstream at all (the stub rejects it).
    const vault = new MemoryProviderVault();
    await vault.saveKey('mock', 'sk-real-key-will-be-rejected');
    gateway = await startGateway({
      token: 'local-gateway-token',
      providers: providers(upstream.url, ['m1']),
      vault,
      redact: createRedactor().redact,
    });
    const res = await fetch(`http://127.0.0.1:${gateway.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-gateway-token', 'x-aik-provider': 'mock' },
      body: JSON.stringify({ model: 'm1' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('[aik-provider-error]');
    expect(parseProviderFailure(body.error.message)).toMatchObject({ status: 401, reason: 'auth', provider: 'mock' });
    upstream.close();
  });
});
