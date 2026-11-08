// apps/orchestrator/src/metrics/usage-service.ts
import {
  agentRuns,
  modelProfiles,
  modelUsage,
  providers,
  projects,
  type AikDb,
} from '@aik/db';
import { and, eq, gte, lte } from 'drizzle-orm';

export interface UsageModelBreakdown {
  modelProfileId: number | null;
  modelId: string;
  provider: string;
  costUsd: number;
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
  totalCostUsd: number;
  costComplete: boolean;
  estimated: boolean;
  byDay: { day: string; costUsd: number; runs: number }[];
  byProject: { projectId: number; projectKey: string; costUsd: number; runs: number }[];
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
  storyId?: number;
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

    if (filters?.projectId !== undefined) conditions.push(eq(modelUsage.projectId, filters.projectId));
    if (filters?.storyId !== undefined) conditions.push(eq(modelUsage.storyId, filters.storyId));
    const rows = this.db.select({
      id: modelUsage.id, httpStatus: modelUsage.httpStatus, agentRunId: modelUsage.agentRunId,
      runStatus: agentRuns.status, inputTokens: modelUsage.inputTokens, outputTokens: modelUsage.outputTokens,
      latencyMs: modelUsage.latencyMs, durationMs: modelUsage.durationMs, fallbackFrom: modelUsage.fallbackFrom,
      modelProfileId: modelUsage.modelProfileId, modelId: modelProfiles.modelId, modelSlug: modelUsage.modelSlug,
      providerName: providers.name, createdAt: modelUsage.createdAt, costUsd: modelUsage.costUsd,
      costSource: modelUsage.costSource, projectId: modelUsage.projectId, projectKey: projects.key,
    }).from(modelUsage)
      .leftJoin(modelProfiles, eq(modelUsage.modelProfileId, modelProfiles.id))
      .leftJoin(providers, eq(modelProfiles.providerId, providers.id))
      .leftJoin(agentRuns, eq(modelUsage.agentRunId, agentRuns.id))
      .leftJoin(projects, eq(modelUsage.projectId, projects.id))
      .where(and(...conditions)).all();
    const byDay = new Map<string, UsageSummaryDTO['byDay'][number]>();
    const byProject = new Map<number, UsageSummaryDTO['byProject'][number]>();
    const totalRequests = rows.length;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalLatency = 0;
    let successCount = 0;
    let fallbackCount = 0;

    const modelsMap = new Map<string, UsageModelBreakdown>();

    for (const row of rows) {
      const inTok = row.inputTokens ?? 0;
      const outTok = row.outputTokens ?? 0;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      const latency = row.latencyMs ?? row.durationMs ?? 0;
      totalLatency += latency;
      const cost = row.costUsd ?? 0;
      const date = row.createdAt;
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const daily = byDay.get(day) ?? { day, costUsd: 0, runs: 0 };
      daily.costUsd += cost; daily.runs++; byDay.set(day, daily);
      if (row.projectId !== null) {
        const project = byProject.get(row.projectId) ?? { projectId: row.projectId, projectKey: row.projectKey ?? '', costUsd: 0, runs: 0 };
        project.costUsd += cost; project.runs++; byProject.set(row.projectId, project);
      }

      const isSuccess = row.httpStatus !== null ? row.httpStatus >= 200 && row.httpStatus < 300 : row.agentRunId === null || row.runStatus === 'succeeded';
      if (isSuccess) successCount++;
      if (row.fallbackFrom !== null) fallbackCount++;

      const modelKey = row.modelProfileId !== null ? `profile:${row.modelProfileId}` : `slug:${row.modelSlug ?? 'unknown'}`;
      let m = modelsMap.get(modelKey);
      if (!m) {
        m = {
          modelProfileId: row.modelProfileId,
          modelId: row.modelId ?? row.modelSlug ?? 'Unknown model',
          provider: row.providerName ?? row.modelSlug?.split('/')[0] ?? 'Unknown provider',
          costUsd: 0,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          avgLatencyMs: 0,
          successCount: 0,
          errorCount: 0,
          fallbackCount: 0,
        };
        modelsMap.set(modelKey, m);
      }

      m.requests++;
      m.costUsd += cost;
      m.inputTokens += inTok;
      m.outputTokens += outTok;
      m.avgLatencyMs += latency; // temporarily sum latency
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
      totalCostUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      costComplete: rows.every((row) => row.costSource !== 'unknown'),
      estimated: rows.some((row) => row.costSource === 'estimated'),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      byProject: [...byProject.values()],
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
