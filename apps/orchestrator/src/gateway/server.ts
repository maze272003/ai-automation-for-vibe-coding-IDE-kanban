// apps/orchestrator/src/gateway/server.ts — the loopback model proxy (spec PK-3).
// The provider key is read from the vault, injected into the last-moment upstream
// request and never stored, logged or returned. One provider per request: the
// gateway never attempts a second provider and never falls back to another one.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { failureReasonForStatus, formatProviderFailure } from '@aik/contracts';
import type { AuthFlavour } from '@aik/providers';
import type { ProviderVault } from '../providers/vault.ts';
import { buildUpstreamCall, localToken } from './upstream.ts';

export interface GatewayProviderSource {
  findConnected(providerId: string): { baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
  findByModel(modelId: string): { id: string; baseUrl: string; auth: AuthFlavour; modelIds: string[] } | null;
  markQuotaExhausted(providerId: string, status: number, until: number | null): void;
}

export interface GatewayDeps {
  token: string;
  providers: GatewayProviderSource;
  vault: ProviderVault;
  redact: (text: string) => string;
  logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

export interface RunningGateway {
  port: number;
  close(): Promise<void>;
}

// A 5xx or a transport failure is retried twice with backoff (spec PK-7) — always
// against the same provider. A 4xx is the caller's problem and is answered immediately.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500] as const;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The model id from the body's `model` field, or from a Google-style `/models/<id>:…` path. */
function modelIdOf(path: string, body: Buffer): string | null {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.length > 0) return parsed.model;
    } catch {
      // Not JSON — fall through to the path.
    }
  }
  const fromPath = /\/models\/([^/:]+)/.exec(path)?.[1];
  return fromPath ?? null;
}

/** Frees an unread 5xx body so the socket can be reused for the retry. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already gone — nothing to discard.
  }
}

function respondJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function startGateway(deps: GatewayDeps): Promise<RunningGateway> {
  const server = http.createServer((req, res) => {
    // A client hanging up mid-stream (e.g. OpenCode cancels a turn) must not crash the process.
    res.on('error', () => {
      // Nothing to recover — the request is already gone.
    });
    void handle(deps, req, res).catch((err) => {
      deps.logger?.warn({ err }, 'gateway request failed');
      if (!res.headersSent) {
        respondJson(res, 500, { error: { message: 'The gateway failed to handle the request' } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    close: async () => {
      // The in-test and app-shutdown callers stop while OpenCode clients may sit in a
      // keep-alive pool; drop idle sockets first so `close` cannot hang on them.
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}

async function handle(deps: GatewayDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v) && v.length > 0) headers[k] = v.join(', ');
  }

  const presented = localToken(headers, url.search.slice(1));
  if (!presented || !safeEqual(presented, deps.token)) {
    respondJson(res, 401, { error: { message: 'Missing or invalid gateway token' } });
    return;
  }

  const body = await readBody(req);
  const providerId = headers['x-aik-provider'] ?? null;
  const modelId = modelIdOf(url.pathname, body);

  let target = providerId ? deps.providers.findConnected(providerId) : null;
  let resolvedId = providerId;
  if (!target && modelId) {
    // SPK-5 P-2: some AI SDK packages do not forward options.headers, so resolve by model.
    // This happens before any upstream call — never a second provider after a failure.
    const byModel = deps.providers.findByModel(modelId);
    if (byModel) {
      target = byModel;
      resolvedId = byModel.id;
    }
  }
  if (!target || !resolvedId) {
    respondJson(res, 401, { error: { code: 'PROVIDER_NOT_CONNECTED', message: 'That provider is not connected' } });
    return;
  }
  if (modelId && !target.modelIds.includes(modelId)) {
    respondJson(res, 400, { error: { message: `The model ${modelId} does not belong to ${resolvedId}` } });
    return;
  }

  const key = await deps.vault.loadKey(resolvedId);
  if (!key) {
    respondJson(res, 401, { error: { code: 'PROVIDER_NOT_CONNECTED', message: 'That provider is not connected' } });
    return;
  }

  // buildUpstreamCall strips the incoming credential headers and injects the vault key.
  const call = buildUpstreamCall({ baseUrl: target.baseUrl, auth: target.auth, key }, { path: url.pathname, query: url.search.slice(1), headers });

  let upstream: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      upstream = await fetch(call.url, {
        method: req.method,
        headers: call.headers,
        // `new Uint8Array(body)` copies the same bytes; that copy is what keeps
        // Buffer's shared ArrayBufferLike out of `BodyInit`'s stricter typing.
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(600_000),
      });
    } catch (err) {
      lastError = err;
      upstream = null;
    }
    // Only a 5xx or a transport failure is retried; a 4xx is the caller's problem.
    const retryable = upstream === null || upstream.status >= 500;
    if (!retryable) break;
    if (attempt < MAX_ATTEMPTS - 1) {
      if (upstream) await discardBody(upstream);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 1500));
    }
  }

  if (!upstream) {
    const message = formatProviderFailure({
      status: 0,
      reason: 'provider_down',
      provider: resolvedId,
      detail: deps.redact(lastError instanceof Error ? lastError.message : String(lastError)),
    });
    respondJson(res, 502, { error: { message } });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const reason = failureReasonForStatus(upstream.status);
    if (reason === 'quota') {
      deps.providers.markQuotaExhausted(resolvedId, upstream.status, null);
    }
    const message = formatProviderFailure({
      status: upstream.status,
      reason,
      provider: resolvedId,
      detail: deps.redact(text).slice(0, 300),
    });
    respondJson(res, upstream.status, { error: { message } });
    return;
  }

  // Byte-exact streaming pass-through: write every chunk as it arrives, never
  // buffering the whole (possibly SSE) response.
  const outHeaders: Record<string, string> = {};
  const contentType = upstream.headers.get('content-type');
  if (contentType) outHeaders['content-type'] = contentType;
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}
