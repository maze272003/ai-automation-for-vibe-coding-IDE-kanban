// apps/orchestrator/src/metrics/usage-service.ts
import {
  agentRuns,
  modelProfiles,
  modelUsage,
  providers,
  userStories,
  type AikDb,
} from '@aik/db';
import { and, eq, gte, lte } from 'drizzle-orm';

export interface UsageModelBreakdown {
  modelProfileId: number;
  modelId: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  successCount: number;
  errorCount: number;
  fallbackCount: number;
}

export interface ProviderQuotaSummary {
  providerId: number;
  provider: string;
  remaining: number | null;
  exhaustedUntil: number | null;
  lastStatus: number | null;
}

export interface UsageSummaryDTO {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  successRate: number;
  fallbackCount: number;
  models: UsageModelBreakdown[];
  quotas: ProviderQuotaSummary[];
}

export interface UsageFilterOptions {
  projectId?: number;
  from?: Date | number;
  to?: Date | number;
}

export class UsageMetricsService {
  private readonly db: AikDb;

  constructor(deps: { db: AikDb }) {
    this.db = deps.db;
  }

  async getUsageSummary(filters?: UsageFilterOptions): Promise<UsageSummaryDTO> {
    const conditions = [];

    if (filters?.from !== undefined) {
      const fromDate = typeof filters.from === 'number' ? new Date(filters.from) : filters.from;
      conditions.push(gte(modelUsage.createdAt, fromDate));
    }
    if (filters?.to !== undefined) {
      const toDate = typeof filters.to === 'number' ? new Date(filters.to) : filters.to;
      conditions.push(lte(modelUsage.createdAt, toDate));
    }

    let rows: Array<{
      id: number;
      httpStatus: number;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
      fallbackFrom: number | null;
      modelProfileId: number;
      modelId: string;
      providerName: string;
      createdAt: Date;
    }>;

    if (filters?.projectId !== undefined) {
      conditions.push(eq(userStories.projectId, filters.projectId));
      rows = this.db
        .select({
          id: modelUsage.id,
          httpStatus: modelUsage.httpStatus,
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
          latencyMs: modelUsage.latencyMs,
          fallbackFrom: modelUsage.fallbackFrom,
          modelProfileId: modelUsage.modelProfileId,
          modelId: modelProfiles.modelId,
          providerName: providers.name,
          createdAt: modelUsage.createdAt,
        })
        .from(modelUsage)
        .innerJoin(modelProfiles, eq(modelUsage.modelProfileId, modelProfiles.id))
        .innerJoin(providers, eq(modelProfiles.providerId, providers.id))
        .innerJoin(agentRuns, eq(modelUsage.agentRunId, agentRuns.id))
        .innerJoin(userStories, eq(agentRuns.storyId, userStories.id))
        .where(and(...conditions))
        .all();
    } else {
      rows = this.db
        .select({
          id: modelUsage.id,
          httpStatus: modelUsage.httpStatus,
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
          latencyMs: modelUsage.latencyMs,
          fallbackFrom: modelUsage.fallbackFrom,
          modelProfileId: modelUsage.modelProfileId,
          modelId: modelProfiles.modelId,
          providerName: providers.name,
          createdAt: modelUsage.createdAt,
        })
        .from(modelUsage)
        .innerJoin(modelProfiles, eq(modelUsage.modelProfileId, modelProfiles.id))
        .innerJoin(providers, eq(modelProfiles.providerId, providers.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .all();
    }

    const totalRequests = rows.length;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalLatency = 0;
    let successCount = 0;
    let fallbackCount = 0;

    const modelsMap = new Map<number, UsageModelBreakdown>();

    for (const row of rows) {
      const inTok = row.inputTokens ?? 0;
      const outTok = row.outputTokens ?? 0;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      totalLatency += row.latencyMs;

      const isSuccess = row.httpStatus >= 200 && row.httpStatus < 300;
      if (isSuccess) successCount++;
      if (row.fallbackFrom !== null) fallbackCount++;

      let m = modelsMap.get(row.modelProfileId);
      if (!m) {
        m = {
          modelProfileId: row.modelProfileId,
          modelId: row.modelId,
          provider: row.providerName,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          avgLatencyMs: 0,
          successCount: 0,
          errorCount: 0,
          fallbackCount: 0,
        };
        modelsMap.set(row.modelProfileId, m);
      }

      m.requests++;
      m.inputTokens += inTok;
      m.outputTokens += outTok;
      m.avgLatencyMs += row.latencyMs; // temporarily sum latency
      if (isSuccess) {
        m.successCount++;
      } else {
        m.errorCount++;
      }
      if (row.fallbackFrom !== null) {
        m.fallbackCount++;
      }
    }

    // Finalize averages
    for (const m of modelsMap.values()) {
      if (m.requests > 0) {
        m.avgLatencyMs = Math.round(m.avgLatencyMs / m.requests);
      }
    }

    const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;
    const successRate = totalRequests > 0 ? successCount / totalRequests : 1;

    // Fetch quota status for providers
    const provRows = this.db.select().from(providers).all();
    const quotas: ProviderQuotaSummary[] = provRows.map((p) => ({
      providerId: p.id,
      provider: p.name,
      remaining: p.quotaState?.remaining ?? null,
      exhaustedUntil: p.quotaState?.exhaustedUntil ?? null,
      lastStatus: p.quotaState?.lastStatus ?? null,
    }));

    return {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      avgLatencyMs,
      successRate,
      fallbackCount,
      models: Array.from(modelsMap.values()),
      quotas,
    };
  }
}
