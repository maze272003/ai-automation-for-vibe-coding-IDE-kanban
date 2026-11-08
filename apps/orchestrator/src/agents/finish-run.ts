// apps/orchestrator/src/agents/finish-run.ts
// The single exit path for agent runs: every finish site funnels through here so a run can
// never end without its usage row and run.finished event (spec W0-1, W0-7).
import type { SessionUsage } from '@aik/contracts';
import { agentRuns, userStories, type AikDbOrTx } from '@aik/db';
import { eq } from 'drizzle-orm';
import { recordUsage } from '../metrics/record-usage.ts';
import { emitRunFinished } from './run-events.ts';
import type { ModelRef } from './runtime.ts';

export type RunFinalStatus = 'succeeded' | 'failed' | 'interrupted' | 'timed_out' | 'cancelled';

export function finishRun(
  db: AikDbOrTx,
  now: Date,
  input: {
    runId: number;
    status: RunFinalStatus;
    exitReason: string | null;
    usage: SessionUsage | null;
    model: ModelRef | null;
    durationMs: number | null;
  },
): void {
  const run = db
    .select({ id: agentRuns.id, storyId: agentRuns.storyId, modelProfileId: agentRuns.modelProfileId, endedAt: agentRuns.endedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, input.runId))
    .get();
  if (!run || run.endedAt) return;

  const story = db
    .select({ projectId: userStories.projectId })
    .from(userStories)
    .where(eq(userStories.id, run.storyId))
    .get();

  const price = recordUsage(db, now, {
    agentRunId: run.id,
    storyId: run.storyId,
    projectId: story?.projectId ?? null,
    runtime: 'opencode',
    providerId: input.model?.providerID ?? null,
    modelId: input.model?.id ?? null,
    modelProfileId: run.modelProfileId,
    usage: input.usage,
    durationMs: input.durationMs,
  });

  db.update(agentRuns)
    .set({
      status: input.status,
      exitReason: input.exitReason,
      endedAt: now,
      usage: {
        requests: input.usage?.assistantMessages ?? 0,
        inTok: input.usage?.inputTokens ?? 0,
        outTok: input.usage?.outputTokens ?? 0,
        cachedInTok: input.usage?.cachedInputTokens ?? undefined,
        costUsd: price.costUsd,
        costSource: price.costSource,
      },
    })
    .where(eq(agentRuns.id, input.runId))
    .run();

  emitRunFinished(db, now, input.runId, input.status, input.exitReason ?? undefined);
}
