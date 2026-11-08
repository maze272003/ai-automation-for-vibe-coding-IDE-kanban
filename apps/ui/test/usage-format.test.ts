import { expect, it } from 'vitest';
import { costLabel, formatUsd } from '../src/lib/usage-format.ts';
it('formats unknown, small, zero, and large dollar amounts', () => {
  expect(formatUsd(null)).toBe('—'); expect(formatUsd(0.004)).toBe('<$0.01');
  expect(formatUsd(1234.5)).toBe('$1,234.50'); expect(formatUsd(0)).toBe('$0.00');
});
it('labels estimated and incomplete totals independently', () => {
  expect(costLabel({ estimated: false, costComplete: true })).toBeNull();
  expect(costLabel({ estimated: true, costComplete: true })).toBe('estimated');
  expect(costLabel({ estimated: false, costComplete: false })).toBe('incomplete');
  expect(costLabel({ estimated: true, costComplete: false })).toBe('estimated · incomplete');
});
