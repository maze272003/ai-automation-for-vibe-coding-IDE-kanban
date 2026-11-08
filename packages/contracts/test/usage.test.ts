import { expect, it } from 'vitest';
import { extractSessionUsage } from '../src/usage.ts';

it('sums assistant usage and ignores other messages', () => {
  expect(extractSessionUsage([
    { type: 'user', tokens: { input: 100 } },
    { type: 'assistant', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3 } } },
    { type: 'assistant', cost: 0.02, tokens: { input: 1, output: 1 } },
    { type: 'idle' },
  ])).toEqual({ inputTokens: 11, outputTokens: 6, reasoningTokens: 2, cachedInputTokens: 3, reportedCostUsd: 0.03, assistantMessages: 2 });
});

it('does not treat zero cost as reported', () => {
  expect(extractSessionUsage([{ type: 'assistant', cost: 0, tokens: {} }])?.reportedCostUsd).toBeNull();
});

it('requires an assistant tokens object', () => {
  for (const messages of [[], [null], [{ type: 'assistant' }], [{ type: 'assistant', tokens: [] }]]) {
    expect(extractSessionUsage(messages)).toBeNull();
  }
});

it('ignores malformed and non-finite numeric fields', () => {
  expect(extractSessionUsage([{ type: 'assistant', cost: NaN, tokens: { input: '5', output: Infinity, reasoning: -1, cache: null } }]))
    .toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, reportedCostUsd: null, assistantMessages: 1 });
});
