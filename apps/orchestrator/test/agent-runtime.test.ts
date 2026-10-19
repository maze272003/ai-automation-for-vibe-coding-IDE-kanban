import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OpenCodeRuntime } from '../src/agents/runtime.ts';

describe('OpenCodeRuntime', () => {
  let server: http.Server;
  let baseUrl: string;
  const authPassword = 'test-secret-password';
  const expectedAuth = `Basic ${Buffer.from(`opencode:${authPassword}`).toString('base64')}`;

  const receivedRequests: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  let activeSessions: string[] = [];
  let mockMessages: { type: string; content?: { type: string; text: string }[] }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let bodyText = '';
      req.on('data', (chunk) => {
        bodyText += chunk.toString();
      });
      req.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(bodyText);
        } catch {
          json = bodyText;
        }
        receivedRequests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: req.headers.authorization,
          body: json,
        });

        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/session') {
          const id = (json as { id?: string })?.id ?? 'ses_test123';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id }));
          return;
        }

        if (req.method === 'POST' && req.url?.startsWith('/api/session/') && req.url.endsWith('/prompt')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'GET' && req.url === '/api/session/active') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: activeSessions }));
          return;
        }

        if (req.method === 'GET' && req.url?.startsWith('/api/session/') && req.url.endsWith('/message')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: mockMessages }));
          return;
        }

        if (req.method === 'DELETE' && req.url?.startsWith('/api/session/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('creates a session, sends prompt, waits for idle, and retrieves assistant text', async () => {
    mockMessages = [
      { type: 'user', content: [{ type: 'text', text: 'Hello model' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Hello! I am ready to implement this story.' }] },
    ];
    activeSessions = []; // immediate idle

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      title: 'Test Story Run',
      directory: 'C:/temp/worktree',
      prompt: 'Hello model',
      model: { id: 'glm-5.3-flash', providerID: 'zai-coding-plan' },
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hello! I am ready to implement this story.');

    const createReq = receivedRequests.find((r) => r.method === 'POST' && r.url === '/api/session');
    expect(createReq).toBeDefined();
    expect(createReq?.auth).toBe(expectedAuth);
    expect((createReq?.body as { model?: { id: string } })?.model?.id).toBe('glm-5.3-flash');

    const promptReq = receivedRequests.find((r) => r.method === 'POST' && r.url?.endsWith('/prompt'));
    expect(promptReq).toBeDefined();
    expect((promptReq?.body as { text: string })?.text).toBe('Hello model');
  });

  test('reports errors if OpenCode returns error outcome', async () => {
    mockMessages = [
      {
        type: 'idle',
        outcome: 'failed',
        error: { message: 'Provider rate limit exceeded' },
      } as unknown as { type: string },
    ];
    activeSessions = [];

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Do something',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Provider rate limit exceeded');
  });

  test('calls onSessionCreated callback and fetches session messages', async () => {
    mockMessages = [
      { type: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ];
    activeSessions = [];

    let capturedSessionId: string | null = null;
    let capturedModelId: string | null = null;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Hello',
      model: { id: 'glm-5.3-flash', providerID: 'zai-coding-plan' },
      onSessionCreated: (sessionId, model) => {
        capturedSessionId = sessionId;
        capturedModelId = model?.id ?? null;
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedSessionId).toMatch(/^ses_aik/);
    expect(capturedModelId).toBe('glm-5.3-flash');

    const messagesRes = await runtime.getSessionMessages(capturedSessionId!, 'C:/temp/worktree');
    expect(messagesRes.ok).toBe(true);
    expect(messagesRes.messages.length).toBe(2);
  });
});
