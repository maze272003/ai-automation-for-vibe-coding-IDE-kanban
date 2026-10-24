// apps/ui/test/usage-dashboard.test.ts
import { describe, expect, test } from 'vitest';
import {
  formatLatency,
  formatQuotaReset,
  formatTokens,
} from '../src/components/UsageDashboard.tsx';

describe('REL-5 Usage Dashboard Formatters and Logic', () => {
  test('formats token counts with k and M units', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(12_400_000)).toBe('12.4M');
  });

  test('formats latencies in milliseconds and seconds', () => {
    expect(formatLatency(0)).toBe('0ms');
    expect(formatLatency(240)).toBe('240ms');
    expect(formatLatency(999)).toBe('999ms');
    expect(formatLatency(1200)).toBe('1.2s');
    expect(formatLatency(3500)).toBe('3.5s');
  });

  test('calculates human-readable quota reset countdowns', () => {
    const now = 1700000000000;
    expect(formatQuotaReset(null, now)).toBe('Available');
    expect(formatQuotaReset(now - 1000, now)).toBe('Ready');
    expect(formatQuotaReset(now + 45_000, now)).toBe('in 45s');
    expect(formatQuotaReset(now + 15 * 60_000, now)).toBe('in 15m');
    expect(formatQuotaReset(now + 2 * 3600_000, now)).toBe('in 2h');
  });
});
