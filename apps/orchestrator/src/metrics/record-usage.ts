import type { CostSource, SessionUsage } from '@aik/contracts';
import { modelUsage, type AikDbOrTx } from '@aik/db';
import { priceUsage } from '@aik/providers';
import { appendOutbox } from '../events/outbox.ts';

export interface RecordUsageInput {
  agentRunId: number | null; storyId: number | null; projectId: number | null;
  runtime: 'opencode'; providerId: string | null; modelId: string | null; modelProfileId: number | null;
  usage: SessionUsage | null; durationMs: number | null;
}

export function recordUsage(db: AikDbOrTx, now: Date, input: RecordUsageInput): { id: number; costUsd: number | null; costSource: CostSource } {
  const price = priceUsage(input);
  const row = db.insert(modelUsage).values({
    agentRunId: input.agentRunId, storyId: input.storyId, projectId: input.projectId,
    runtime: input.runtime, modelProfileId: input.modelProfileId,
    modelSlug: input.providerId && input.modelId ? `${input.providerId}/${input.modelId}` : null,
    inputTokens: input.usage?.inputTokens ?? null, outputTokens: input.usage?.outputTokens ?? null,
    cachedInputTokens: input.usage?.cachedInputTokens ?? null, durationMs: input.durationMs,
    httpStatus: null, latencyMs: null, createdAt: now, ...price,
  }).returning({ id: modelUsage.id }).get();
  appendOutbox(db, { topic: 'usage.recorded', provenance: 'system', storyId: input.storyId,
    data: { usageId: row.id, agentRunId: input.agentRunId, ...price } }, now);
  return { id: row.id, ...price };
}
