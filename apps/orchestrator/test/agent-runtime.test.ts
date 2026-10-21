import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { OpenCodeRuntime } from '../src/agents/runtime.ts';

type MockMessage = { type: string; outcome?: string; finish?: string; content?: { type: string; text: string }[]; time?: { created: number } };

/** The transcript exactly as the pinned server returns it: newest first, no idle yet. */
function succeededRun(answer: string): MockMessage[] {
  return [
    { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: answer }], time: { created: 2 } },
    { type: 'user', content: [{ type: 'text', text: 'prompt' }], time: { created: 1 } },
  ];
}

describe('OpenCodeRuntime', () => {
  let server: http.Server;
  let baseUrl: string;
  const authPassword = 'test-secret-password';
  const expectedAuth = `Basic ${Buffer.from(`opencode:${authPassword}`).toString('base64')}`;

  const receivedRequests: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  let activeSessions: string[] = [];
  let mockMessages: MockMessage[] = [];
  // Interrupt-test knobs: when autoActivate is set the fake server marks every created session
  // active; when an interrupt call is honored it clears the active set (otherwise ignored).
  let autoActivate = false;
  let interruptHonored = true;
  // The status the fake server answers a prompt with (a rejected prompt must be reported).
  let promptStatus = 200;
  // Session lifecycle of the fake server: the session shows up as active only after
  // `sessionStartDelayPolls` polls (the server registers it a moment after the prompt was
  // admitted) and stays active for `sessionActivePolls` polls (-1 = it never goes idle).
  let sessionStartDelayPolls = 0;
  let sessionActivePolls = 0;
  let activePolls = 0;

  const sessionVisible = (): boolean => {
    if (activePolls <= sessionStartDelayPolls) return false;
    if (sessionActivePolls < 0) return true;
    return activePolls <= sessionStartDelayPolls + sessionActivePolls;
  };
  const sessionDone = (): boolean => sessionActivePolls >= 0 && activePolls > sessionStartDelayPolls + sessionActivePolls;

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
          if (autoActivate) activeSessions.push(id);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id }));
          return;
        }

        if (req.method === 'POST' && req.url?.startsWith('/api/session/') && req.url.endsWith('/prompt')) {
          res.writeHead(promptStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify(promptStatus === 200 ? { ok: true } : { error: { name: 'SessionNotFoundError', data: { message: 'no such session' } } }));
          return;
        }

        if (req.method === 'POST' && req.url?.startsWith('/api/session/') && req.url.endsWith('/interrupt')) {
          if (interruptHonored) activeSessions.length = 0;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'GET' && req.url === '/api/session/active') {
          activePolls += 1;
          const visible = sessionVisible() ? activeSessions : [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: visible }));
          return;
        }

        if (req.method === 'GET' && req.url?.startsWith('/api/session/') && req.url.endsWith('/message')) {
          // The server writes the terminal `idle` message when the run ends; until then only the
          // transcript so far exists.
          const data = sessionDone() ? [{ type: 'idle', outcome: 'succeeded' }, ...mockMessages] : mockMessages;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data }));
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

  beforeEach(() => {
    activeSessions = [];
    mockMessages = [];
    autoActivate = false;
    interruptHonored = true;
    promptStatus = 200;
    sessionStartDelayPolls = 0;
    sessionActivePolls = 0;
    activePolls = 0;
  });

  test('creates a session, sends prompt, waits for idle, and retrieves assistant text', async () => {
    mockMessages = succeededRun('Hello! I am ready to implement this story.');
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

  test('reads the answer from a newest-first message list whose newest assistant message is a tool call', async () => {
    // The shape the pinned server returns: newest first, the newest assistant message is a tool
    // call without any text, and the answer sits in an earlier message. Reading the newest
    // assistant message alone reported "The model returned no text" for runs that had actually
    // produced a full answer, which stalled the board on every story.
    mockMessages = [
      { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'The final answer.' }], time: { created: 4 } },
      { type: 'assistant', finish: 'tool-calls', content: [{ type: 'tool', text: '' }], time: { created: 3 } },
      { type: 'assistant', finish: 'tool-calls', content: [{ type: 'tool', text: '' }], time: { created: 2 } },
      { type: 'user', content: [{ type: 'text', text: 'do the work' }], time: { created: 1 } },
    ];
    activeSessions = [];

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({ directory: 'C:/temp/worktree', prompt: 'do the work' });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('The final answer.');
  });

  test('waits for a session that is not active yet instead of ending the run', async () => {
    // The server registers a session a moment after the prompt was admitted: the first polls
    // do not list it as active. The run must not be mistaken for a finished one.
    mockMessages = succeededRun('Answer after a slow start.');
    activeSessions = [];
    sessionStartDelayPolls = 2;
    sessionActivePolls = 3;
    autoActivate = true;
    const firstIndex = receivedRequests.length;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({ directory: 'C:/temp/worktree', prompt: 'do the work' });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Answer after a slow start.');
    // The run waited for the session instead of ending on the first poll.
    const polls = receivedRequests.slice(firstIndex).filter((r) => r.method === 'GET' && r.url === '/api/session/active').length;
    expect(polls).toBeGreaterThanOrEqual(5);
  });

  test('interrupts the session and reports the timeout when the run overruns its budget', async () => {
    // Without the interrupt the model keeps working (and billing) on a result nobody reads.
    mockMessages = [];
    activeSessions = [];
    sessionStartDelayPolls = 0;
    sessionActivePolls = -1; // the session never goes idle
    autoActivate = true;
    const firstIndex = receivedRequests.length;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({ directory: 'C:/temp/worktree', prompt: 'do the work', timeoutMs: 1_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not finish within 1 seconds');
    const runRequests = receivedRequests.slice(firstIndex);
    expect(runRequests.filter((r) => r.method === 'POST' && r.url?.endsWith('/interrupt')).length).toBe(1);
  });

  test('reports the server error when OpenCode rejects the prompt', async () => {
    mockMessages = [];
    activeSessions = [];
    sessionStartDelayPolls = 0;
    sessionActivePolls = 0;
    autoActivate = false;
    promptStatus = 404;
    const firstIndex = receivedRequests.length;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({ directory: 'C:/temp/worktree', prompt: 'do the work' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('rejected the prompt (404)');
    expect(result.error).toContain('no such session');
    // A rejected prompt must not be reported as a model failure with no text.
    expect(receivedRequests.slice(firstIndex).some((r) => r.method === 'GET' && r.url?.endsWith('/message'))).toBe(false);
    promptStatus = 200;
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
    mockMessages = succeededRun('Done');
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
    expect(messagesRes.messages.length).toBe(3);
  });

  test('returns interrupted without creating a session when shouldStop is already true', async () => {
    mockMessages = [];
    activeSessions = [];
    autoActivate = false;
    interruptHonored = true;
    const firstIndex = receivedRequests.length;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Hello model',
      shouldStop: () => true,
    });

    expect(result).toEqual({ ok: false, interrupted: true, error: 'Run interrupted before it started' });
    expect(receivedRequests.length).toBe(firstIndex);
  });

  test('interrupts the session once and returns interrupted when stop is requested mid-run', async () => {
    mockMessages = [];
    activeSessions = [];
    autoActivate = true; // the created session shows up as active until interrupted
    interruptHonored = true;
    sessionActivePolls = -1; // it never goes idle on its own
    const firstIndex = receivedRequests.length;
    const startedAt = Date.now();

    let shouldStopCalls = 0;
    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Do the work',
      // False for the pre-start check, true from the first poll iteration on.
      shouldStop: () => ++shouldStopCalls > 1,
    });

    expect(result).toEqual({ ok: false, interrupted: true, error: 'Run interrupted by a stop request' });

    const runRequests = receivedRequests.slice(firstIndex);
    const createReq = runRequests.find((r) => r.method === 'POST' && r.url === '/api/session');
    expect(createReq).toBeDefined();
    const sessionId = (createReq?.body as { id?: string })?.id;
    expect(sessionId).toMatch(/^ses_aik/);

    const interrupts = runRequests.filter((r) => r.method === 'POST' && r.url === `/api/session/${sessionId}/interrupt`);
    expect(interrupts.length).toBe(1);

    // The poll loop aborted instead of reading results or waiting out the timeout.
    expect(runRequests.some((r) => r.method === 'GET' && r.url?.endsWith('/message'))).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('still returns interrupted within the bounded grace when the server ignores the interrupt', async () => {
    mockMessages = [];
    activeSessions = [];
    autoActivate = true;
    interruptHonored = false; // /interrupt replies 200 but the session stays active
    sessionActivePolls = -1; // it stays active
    const firstIndex = receivedRequests.length;
    const startedAt = Date.now();

    let shouldStopCalls = 0;
    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Do the work',
      // Clamps the interrupt grace to this run's own deadline instead of the 10 s cap.
      timeoutMs: 1_200,
      shouldStop: () => ++shouldStopCalls > 1,
    });

    expect(result).toEqual({ ok: false, interrupted: true, error: 'Run interrupted by a stop request' });

    const interrupts = receivedRequests.slice(firstIndex).filter((r) => r.method === 'POST' && r.url?.endsWith('/interrupt'));
    expect(interrupts.length).toBe(1);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_200);
    expect(elapsed).toBeLessThan(5_000);
  });

  test('completes normally without interrupting when shouldStop never turns true', async () => {
    mockMessages = succeededRun('Finished the story work.');
    activeSessions = []; // immediate idle
    autoActivate = false;
    interruptHonored = true;
    const firstIndex = receivedRequests.length;

    const runtime = new OpenCodeRuntime({ baseUrl, password: authPassword });
    const result = await runtime.runOneShot({
      directory: 'C:/temp/worktree',
      prompt: 'Hello model',
      shouldStop: () => false,
    });

    expect(result).toEqual({ ok: true, text: 'Finished the story work.' });
    const runRequests = receivedRequests.slice(firstIndex);
    expect(runRequests.some((r) => r.method === 'POST' && r.url?.endsWith('/interrupt'))).toBe(false);
  });
});
