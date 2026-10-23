import { describe, expect, it } from 'vitest';
import { formatProviderFailure, parseProviderFailure } from '@aik/contracts';

describe('the provider failure marker', () => {
  it('round-trips a failure', () => {
    const text = formatProviderFailure({ status: 401, reason: 'auth', provider: 'zai', detail: 'invalid api key' });
    expect(parseProviderFailure(`Some noise before it. ${text}`)).toEqual({
      status: 401,
      reason: 'auth',
      provider: 'zai',
      detail: 'invalid api key',
    });
  });

  it('returns null for an ordinary error', () => {
    expect(parseProviderFailure('the model timed out')).toBeNull();
  });

  it('maps the statuses to the blocked reasons', () => {
    expect(formatProviderFailure({ status: 429, reason: 'quota', provider: 'x', detail: '' })).toContain('reason=quota');
  });
});
