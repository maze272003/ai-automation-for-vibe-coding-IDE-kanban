import { describe, expect, it } from 'vitest';
import { ConnectProviderSchema, failureReasonForStatus, formatProviderFailure, parseProviderFailure } from '../src/index.ts';

describe('the provider failure marker', () => {
  it('round-trips a failure', () => {
    const text = formatProviderFailure({ status: 401, reason: 'auth', provider: 'zai', detail: 'bad key' });
    expect(parseProviderFailure(text)).toEqual({ status: 401, reason: 'auth', provider: 'zai', detail: 'bad key' });
  });

  it('parses a marker embedded in a longer message', () => {
    const text = formatProviderFailure({ status: 401, reason: 'auth', provider: 'zai', detail: 'bad key' });
    expect(parseProviderFailure(`Some noise before it. ${text}`)).toEqual({
      status: 401,
      reason: 'auth',
      provider: 'zai',
      detail: 'bad key',
    });
  });

  it('returns null for an ordinary error', () => {
    expect(parseProviderFailure('some ordinary error')).toBeNull();
  });
});

describe('failureReasonForStatus', () => {
  it('maps the statuses to the blocked reasons', () => {
    expect(failureReasonForStatus(401)).toBe('auth');
    expect(failureReasonForStatus(403)).toBe('auth');
    expect(failureReasonForStatus(429)).toBe('quota');
    expect(failureReasonForStatus(500)).toBe('provider_down');
    expect(failureReasonForStatus(0)).toBe('provider_down');
  });
});

describe('ConnectProviderSchema', () => {
  it('accepts a provider id with a key', () => {
    expect(ConnectProviderSchema.safeParse({ providerId: 'zai', apiKey: 'k' }).success).toBe(true);
  });
  it('rejects an empty provider id', () => {
    expect(ConnectProviderSchema.safeParse({ providerId: '' }).success).toBe(false);
  });
});
