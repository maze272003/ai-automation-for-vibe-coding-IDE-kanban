// apps/ui/src/components/UsageDashboard.tsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.tsx';

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

export function formatTokens(count: number): string {
  if (count <= 0) return '0';
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return `${k % 1 === 0 ? k : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = count / 1_000_000;
  return `${m % 1 === 0 ? m : m.toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${latencyMs}ms`;
  }
  const s = latencyMs / 1000;
  return `${s % 1 === 0 ? s : s.toFixed(1).replace(/\.0$/, '')}s`;
}

export function formatQuotaReset(exhaustedUntil: number | null, now = Date.now()): string {
  if (!exhaustedUntil) return 'Available';
  const diffMs = exhaustedUntil - now;
  if (diffMs <= 0) return 'Ready';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `in ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  return `in ${diffHours}h`;
}

export interface UsageDashboardProps {
  projectId?: number;
  className?: string;
}

export function UsageDashboard({ projectId, className }: UsageDashboardProps) {
  const [data, setData] = useState<UsageSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<'all' | '24h' | '7d' | '30d'>('all');

  const fetchUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', String(projectId));
      if (range === '24h') params.set('from', String(Date.now() - 24 * 3600_000));
      else if (range === '7d') params.set('from', String(Date.now() - 7 * 24 * 3600_000));
      else if (range === '30d') params.set('from', String(Date.now() - 30 * 24 * 3600_000));

      const query = params.toString() ? `?${params.toString()}` : '';
      const res = await api.get<UsageSummaryDTO>(`/metrics/usage${query}`);
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load usage metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchUsage();
  }, [projectId, range]);

  return (
    <div className={`flex flex-col gap-6 p-6 ${className ?? ''}`}>
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Usage & Quotas</h1>
          <p className="text-xs text-muted">
            Token telemetry, request latency, and provider quota reset ETAs (REL-5)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-control border border-border bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setRange('all')}
              className={`rounded-control px-2.5 py-1 font-medium transition-colors ${
                range === 'all' ? 'bg-surface-2 text-foreground font-semibold shadow-sm' : 'text-muted hover:text-foreground'
              }`}
            >
              All Time
            </button>
            <button
              type="button"
              onClick={() => setRange('24h')}
              className={`rounded-control px-2.5 py-1 font-medium transition-colors ${
                range === '24h' ? 'bg-surface-2 text-foreground font-semibold shadow-sm' : 'text-muted hover:text-foreground'
              }`}
            >
              24h
            </button>
            <button
              type="button"
              onClick={() => setRange('7d')}
              className={`rounded-control px-2.5 py-1 font-medium transition-colors ${
                range === '7d' ? 'bg-surface-2 text-foreground font-semibold shadow-sm' : 'text-muted hover:text-foreground'
              }`}
            >
              7d
            </button>
            <button
              type="button"
              onClick={() => setRange('30d')}
              className={`rounded-control px-2.5 py-1 font-medium transition-colors ${
                range === '30d' ? 'bg-surface-2 text-foreground font-semibold shadow-sm' : 'text-muted hover:text-foreground'
              }`}
            >
              30d
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void fetchUsage()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-card border border-danger/40 bg-danger/10 p-4 text-xs text-danger-foreground">
          {error}
        </div>
      )}

      {/* Metric Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border border-border/80 bg-surface/90 backdrop-blur-[12px] shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">Total Requests</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight text-foreground">
              {data ? data.totalRequests.toLocaleString() : '—'}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted">
              {data && (
                <span className={data.successRate >= 0.9 ? 'text-success font-medium' : 'text-warning font-medium'}>
                  {(data.successRate * 100).toFixed(1)}% success
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/80 bg-surface/90 backdrop-blur-[12px] shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight text-foreground">
              {data ? formatTokens(data.totalInputTokens + data.totalOutputTokens) : '—'}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted">
              <span>{data ? formatTokens(data.totalInputTokens) : '0'} in</span>
              <span>·</span>
              <span>{data ? formatTokens(data.totalOutputTokens) : '0'} out</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/80 bg-surface/90 backdrop-blur-[12px] shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">Average Latency</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight text-foreground">
              {data ? formatLatency(data.avgLatencyMs) : '—'}
            </div>
            <div className="mt-1 text-xs text-muted">Across all completed inferences</div>
          </CardContent>
        </Card>

        <Card className="border border-border/80 bg-surface/90 backdrop-blur-[12px] shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted">Fallbacks Triggered</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight text-foreground">
              {data ? data.fallbackCount.toLocaleString() : '—'}
            </div>
            <div className="mt-1 text-xs text-muted">Automatic rate-limit / outage reroutes</div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Quotas */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Provider Quota & Reset ETAs</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data?.quotas.map((q) => {
            const isExhausted = Boolean(q.exhaustedUntil && q.exhaustedUntil > Date.now());
            return (
              <div
                key={q.providerId}
                className="flex items-center justify-between rounded-card border border-border/70 bg-surface/75 p-4 shadow-sm backdrop-blur-[10px]"
              >
                <div>
                  <div className="text-sm font-bold text-foreground capitalize">{q.provider}</div>
                  <div className="text-xs text-muted">
                    {q.remaining !== null ? `${q.remaining.toLocaleString()} requests remaining` : 'Dynamic Quota'}
                  </div>
                </div>
                <Badge tone={isExhausted ? 'danger' : 'muted'} className="font-mono text-xs">
                  {formatQuotaReset(q.exhaustedUntil)}
                </Badge>
              </div>
            );
          })}
          {(!data || data.quotas.length === 0) && (
            <div className="col-span-full rounded-card border border-border/50 bg-surface/40 p-4 text-center text-xs text-muted">
              No configured providers found
            </div>
          )}
        </div>
      </div>

      {/* Models Breakdown Table */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Model Distribution</h2>
        <div className="overflow-hidden rounded-card border border-border/80 bg-surface/90 backdrop-blur-[12px] shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border/60 bg-surface-2/60 text-muted uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 font-semibold">Model</th>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">Requests</th>
                <th className="px-4 py-3 font-semibold">Input Tokens</th>
                <th className="px-4 py-3 font-semibold">Output Tokens</th>
                <th className="px-4 py-3 font-semibold">Avg Latency</th>
                <th className="px-4 py-3 font-semibold">Fallbacks</th>
                <th className="px-4 py-3 font-semibold">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 text-foreground">
              {data?.models.map((m) => (
                <tr key={m.modelProfileId} className="hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono font-bold text-accent-soft-foreground">{m.modelId}</td>
                  <td className="px-4 py-3 capitalize text-muted">{m.provider}</td>
                  <td className="px-4 py-3 font-medium">{m.requests.toLocaleString()}</td>
                  <td className="px-4 py-3">{formatTokens(m.inputTokens)}</td>
                  <td className="px-4 py-3">{formatTokens(m.outputTokens)}</td>
                  <td className="px-4 py-3 font-mono">{formatLatency(m.avgLatencyMs)}</td>
                  <td className="px-4 py-3">
                    {m.fallbackCount > 0 ? (
                      <span className="rounded bg-warning/20 px-1.5 py-0.5 text-warning font-semibold">
                        {m.fallbackCount}
                      </span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {m.errorCount > 0 ? (
                      <span className="rounded bg-danger/20 px-1.5 py-0.5 text-danger font-semibold">
                        {m.errorCount}
                      </span>
                    ) : (
                      '0'
                    )}
                  </td>
                </tr>
              ))}
              {(!data || data.models.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted">
                    No inference usage recorded for this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
