// apps/skill-vault/src/http.ts — polite fetch wrapper: retries, backoff+jitter, Retry-After,
// per-host politeness intervals, timeouts and response size caps. Never logs headers or bodies.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly bodyText: string;

  constructor(status: number, url: string, retryAfterMs: number | undefined, bodyText: string) {
    super(`HTTP ${status} for ${url}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    this.bodyText = bodyText;
  }
}

export class SizeCapError extends Error {
  readonly url: string;
  readonly maxBytes: number;

  constructor(url: string, maxBytes: number) {
    super(`Response from ${url} exceeded size cap of ${maxBytes} bytes`);
    this.name = 'SizeCapError';
    this.url = url;
    this.maxBytes = maxBytes;
  }
}

export type RetryNotice = { url: string; attempt: number; delayMs: number; reason: string };

export type HttpClientOptions = {
  userAgent: string;
  minIntervalMs: number;
  maxRetries: number;
  timeoutMs: number;
  fetch?: FetchLike;
  onRetry?: (notice: RetryNotice) => void;
  sleeper?: (ms: number) => Promise<void>;
};

export type CappedResponse = { status: number; headers: Headers; body: Buffer };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

const jitter = (max: number) => Math.floor(Math.random() * Math.min(max, 250));

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
};

/** Read a response body fully into memory while enforcing a byte cap. */
async function readCapped(url: string, response: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength ?? 0;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SizeCapError(url, maxBytes);
      }
      chunks.push(Buffer.from(value ?? new Uint8Array()));
    }
  }
  return Buffer.concat(chunks);
}

export class PoliteHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly lastRequestAt = new Map<string, number>();
  private readonly opts: HttpClientOptions;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleeper = opts.sleeper ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async respectPoliteness(url: string): Promise<void> {
    const host = new URL(url).host;
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = last + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await this.sleeper(wait);
    this.lastRequestAt.set(host, Date.now());
  }

  private async once(url: string, init: RequestInit): Promise<Response> {
    await this.respectPoliteness(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with retries; returns the fully-read, size-capped body. */
  async request(url: string, init: RequestInit = {}, maxBytes = 10 * 1024 * 1024): Promise<CappedResponse> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.once(url, init);
      } catch (error) {
        if (attempt >= this.opts.maxRetries) throw error;
        const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) + jitter(250);
        attempt += 1;
        this.opts.onRetry?.({ url, attempt, delayMs, reason: `network: ${(error as Error).message}` });
        await this.sleeper(delayMs);
        continue;
      }
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (RETRYABLE_STATUS.has(response.status)) {
        const bodyText = await readCapped(url, response, 64 * 1024).then((b) => b.toString('utf8')).catch(() => '');
        if (attempt >= this.opts.maxRetries) throw new HttpError(response.status, url, retryAfterMs, bodyText);
        const delayMs = Math.max(
          retryAfterMs ?? 0,
          Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) + jitter(250),
        );
        attempt += 1;
        this.opts.onRetry?.({ url, attempt, delayMs, reason: `http ${response.status}` });
        await this.sleeper(delayMs);
        continue;
      }
      if (!response.ok) {
        const bodyText = await readCapped(url, response, 64 * 1024).then((b) => b.toString('utf8')).catch(() => '');
        throw new HttpError(response.status, url, retryAfterMs, bodyText);
      }
      return { status: response.status, headers: response.headers, body: await readCapped(url, response, maxBytes) };
    }
  }

  async getText(url: string, maxBytes = 10 * 1024 * 1024): Promise<string> {
    return (await this.request(url, { headers: { 'user-agent': this.opts.userAgent } }, maxBytes)).body.toString('utf8');
  }

  async getJson<T>(url: string, maxBytes = 10 * 1024 * 1024): Promise<T> {
    return JSON.parse(await this.getText(url, maxBytes)) as T;
  }

  async getBuffer(url: string, maxBytes: number): Promise<Buffer> {
    return (
      await this.request(url, { headers: { 'user-agent': this.opts.userAgent } }, maxBytes)
    ).body;
  }

  async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
    maxBytes = 10 * 1024 * 1024,
  ): Promise<CappedResponse> {
    return this.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': this.opts.userAgent, ...headers },
        body: JSON.stringify(body),
      },
      maxBytes,
    );
  }
}
