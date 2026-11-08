import { expect, it } from 'vitest';
import type { SessionUsage } from '@aik/contracts';
import { CATALOG, findCatalogModel, priceUsage } from '../src/index.ts';

const usage: SessionUsage = { inputTokens: 1e6, outputTokens: 500_000, reasoningTokens: 500_000, cachedInputTokens: 1e6, reportedCostUsd: null, assistantMessages: 1 };
const paid = CATALOG.find((p) => p.costClass === 'paid_metered' && p.models.some((m) => m.inputCost !== null && m.outputCost !== null))!;
const model = paid.models.find((m) => m.inputCost !== null && m.outputCost !== null)!;

it('reported cost wins even for an unknown provider', () => {
  expect(priceUsage({ usage: { ...usage, reportedCostUsd: 0.5 }, providerId: 'missing', modelId: 'missing' })).toEqual({ costUsd: 0.5, costSource: 'reported' });
});
it('local and free providers cost zero without usage or a known model', () => {
  for (const costClass of ['local', 'free']) {
    const provider = CATALOG.find((p) => p.costClass === costClass)!;
    expect(provider).toBeDefined();
    expect(priceUsage({ usage: null, providerId: provider.id, modelId: null })).toEqual({ costUsd: 0, costSource: 'free' });
  }
});
it('estimates input plus output and reasoning, excluding cached input', () => {
  expect(priceUsage({ usage, providerId: paid.id, modelId: model.id })).toEqual({ costUsd: model.inputCost! + model.outputCost!, costSource: 'estimated' });
});
it('unknown providers, unknown models and missing paid usage stay unknown', () => {
  for (const input of [
    { usage, providerId: 'not-in-catalog', modelId: 'm' },
    { usage, providerId: null, modelId: null },
    { usage, providerId: paid.id, modelId: 'missing' },
    { usage: null, providerId: paid.id, modelId: model.id },
  ]) expect(priceUsage(input)).toEqual({ costUsd: null, costSource: 'unknown' });
});
it('finds only exact model identifiers', () => {
  expect(findCatalogModel(paid.id, model.id)).toEqual({ provider: paid, model });
  expect(findCatalogModel(paid.id, 'missing')).toEqual({ provider: paid, model: null });
  expect(findCatalogModel('missing', model.id)).toBeNull();
});
