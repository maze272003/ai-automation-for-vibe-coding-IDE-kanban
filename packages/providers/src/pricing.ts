import type { CostSource, SessionUsage } from '@aik/contracts';
import { findProvider } from './index.ts';
import type { CatalogModel, CatalogProvider } from './types.ts';

export function findCatalogModel(providerId: string, modelId: string): {
  provider: CatalogProvider; model: CatalogModel | null;
} | null {
  const provider = findProvider(providerId);
  return provider ? { provider, model: provider.models.find((m) => m.id === modelId) ?? null } : null;
}

export function priceUsage(input: {
  usage: SessionUsage | null; providerId: string | null; modelId: string | null;
}): { costUsd: number | null; costSource: CostSource } {
  const { usage, providerId, modelId } = input;
  if (usage?.reportedCostUsd != null) return { costUsd: usage.reportedCostUsd, costSource: 'reported' };
  const catalog = providerId === null ? null : findCatalogModel(providerId, modelId ?? '');
  if (catalog?.provider.costClass === 'local' || catalog?.provider.costClass === 'free') {
    return { costUsd: 0, costSource: 'free' };
  }
  const model = catalog?.model;
  if (usage && model?.inputCost != null && model.outputCost != null) {
    // Cached inputs are excluded: the catalog does not expose cache pricing.
    return {
      costUsd: (usage.inputTokens * model.inputCost + (usage.outputTokens + usage.reasoningTokens) * model.outputCost) / 1e6,
      costSource: 'estimated',
    };
  }
  return { costUsd: null, costSource: 'unknown' };
}
