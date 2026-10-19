// apps/skill-vault/test/http.test.ts — retries, backoff, Retry-After, politeness, size caps.
import { describe, expect, it } from 'vitest';
import { HttpError, PoliteHttpClient, SizeCapError } from '../src/http.ts';
import { fakeFetch } from './helpers/fixtures.ts';

const baseOptions = {
  userAgent: 'test-agent',
  minIntervalMs: 0,
  maxRetries: 3,
  timeoutMs: 5_000,
};

describe('PoliteHttpClient', () => {
  it('retries network errors with exponential backoff and eventually succeeds', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const http = new PoliteHttpClient({
      ...baseOptions,
      sleeper: async (ms) => {
        sleeps.push(ms);
      },
      fetch: (async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNRESET');
        return new Response('ok');
      }) as typeof fetch,
    });
    const text = await http.getText('https://example.com/data');
    expect(text).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(sleeps[0]!); // backoff grows
  });

  it('honors Retry-After on 429 rate-limit responses', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const http = new PoliteHttpClient({
      ...baseOptions,
      sleeper: async (ms) => {
        sleeps.push(ms);
      },
      fetch: (async () => {
        attempts += 1;
        if (attempts === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
        return new Response('fine');
      }) as typeof fetch,
    });
    const text = await http.getText('https://example.com/rate');
    expect(text).toBe('fine');
    expect(sleeps[0]).toBe(2000);
  });

  it('gives up after maxRetries and surfaces the HttpError', async () => {
    let attempts = 0;
    const http = new PoliteHttpClient({
      ...baseOptions,
      sleeper: async () => {},
      fetch: (async () => {
        attempts += 1;
        return new Response('nope', { status: 503, headers: { 'retry-after': '0' } });
      }) as typeof fetch,
    });
    await expect(http.getText('https://example.com/down')).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(4); // initial + 3 retries
  });

  it('does not retry non-retryable client errors like 404', async () => {
    let attempts = 0;
    const http = new PoliteHttpClient({
      ...baseOptions,
      sleeper: async () => {},
      fetch: (async () => {
        attempts += 1;
        return new Response('missing', { status: 404 });
      }) as typeof fetch,
    });
    await expect(http.getText('https://example.com/gone')).rejects.toThrow(HttpError);
    expect(attempts).toBe(1);
  });

  it('enforces response size caps', async () => {
    const big = 'x'.repeat(1000);
    const http = new PoliteHttpClient({
      ...baseOptions,
      fetch: fakeFetch({ 'https://example.com/big': () => ({ body: big }) }),
    });
    await expect(http.getText('https://example.com/big', 100)).rejects.toBeInstanceOf(SizeCapError);
  });

  it('spaces requests to the same host by the politeness interval', async () => {
    const sleeps: number[] = [];
    const log: Array<{ url: string; at: number }> = [];
    const http = new PoliteHttpClient({
      ...baseOptions,
      minIntervalMs: 50,
      sleeper: async (ms) => {
        sleeps.push(ms);
      },
      fetch: fakeFetch({ 'https://slow.example/': () => ({ body: 'ok' }) }, log),
    });
    await http.getText('https://slow.example/a');
    await http.getText('https://slow.example/b');
    expect(log.length).toBe(2);
    expect(sleeps.some((ms) => ms > 0)).toBe(true);
  });
});
