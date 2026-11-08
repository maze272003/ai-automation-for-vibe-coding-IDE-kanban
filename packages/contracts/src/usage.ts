export const COST_SOURCE = ['reported', 'estimated', 'free', 'unknown'] as const;
export type CostSource = (typeof COST_SOURCE)[number];

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  reportedCostUsd: number | null;
  assistantMessages: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function extractSessionUsage(messages: readonly unknown[]): SessionUsage | null {
  const usage: SessionUsage = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0,
    reportedCostUsd: null, assistantMessages: 0,
  };
  let hasTokens = false;
  let cost = 0;
  for (const value of messages) {
    const message = record(value);
    if (message?.type !== 'assistant') continue;
    usage.assistantMessages++;
    cost += numeric(message.cost);
    const tokens = record(message.tokens);
    if (!tokens) continue;
    hasTokens = true;
    usage.inputTokens += numeric(tokens.input);
    usage.outputTokens += numeric(tokens.output);
    usage.reasoningTokens += numeric(tokens.reasoning);
    usage.cachedInputTokens += numeric(record(tokens.cache)?.read);
  }
  usage.reportedCostUsd = cost > 0 ? cost : null;
  return hasTokens ? usage : null;
}
