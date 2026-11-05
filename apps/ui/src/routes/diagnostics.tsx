// apps/ui/src/routes/diagnostics.tsx — IDE-7 advanced diagnostics page
// (Phase 5.4 spec K-6…K-14). Health, recent errors, a redacted read-only log
// viewer, database backups and the main-process export action.
import { useEffect, useRef, useState } from 'react';
import {
  DIAGNOSTICS_LOG_TAIL,
  DIAGNOSTICS_MAX_BACKUPS,
  DIAGNOSTICS_RESTORE_NOTE,
  type DiagnosticsBackupResult,
  type DiagnosticsBackupsDTO,
  type DiagnosticsErrorDTO,
  type DiagnosticsErrorsDTO,
  type DiagnosticsHealthDTO,
  type DiagnosticsLogContentDTO,
  type DiagnosticsLogListDTO,
} from '@aik/contracts';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Select } from '../components/ui/select.tsx';
import { api } from '../lib/api.ts';
import {
  backupLabel,
  errorLevelTone,
  formatAge,
  formatBytes,
  formatUptime,
  healthTone,
  logOptionLabel,
} from '../lib/diagnostics.ts';

const LOG_AUTO_REFRESH_MS = 5_000;
const ERROR_LIMIT = 50;

const HEALTH_COMPONENT_KEYS = ['db', 'logs', 'backups', 'opencode', 'gateway', 'github', 'ollama'] as const;
type HealthComponentKey = (typeof HEALTH_COMPONENT_KEYS)[number];

const HEALTH_COMPONENT_LABELS: Record<HealthComponentKey, string> = {
  db: 'Database',
  logs: 'Logs',
  backups: 'Backups',
  opencode: 'OpenCode',
  gateway: 'Gateway',
  github: 'GitHub',
  ollama: 'Ollama',
};

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

/** A local wall-clock label for the stale note; renderer-only, no persistence. */
function clockTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'earlier';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function displayTime(iso: string | null): string {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ErrorRow({ error }: { error: DiagnosticsErrorDTO }) {
  return (
    <li className="rounded-control border border-border bg-surface-3 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={errorLevelTone(error.level)}>{error.level}</Badge>
        <span className="break-all font-mono text-[11px] text-muted-2">{error.file}</span>
        <time className="text-[11px] text-muted-2" dateTime={error.time ?? undefined}>
          {displayTime(error.time)}
        </time>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{error.message}</p>
      {error.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted hover:text-foreground">Details</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-muted">
            {error.detail}
          </pre>
        </details>
      )}
    </li>
  );
}

export function DiagnosticsPage() {
  // Request sequence numbers make every loader's last write win; `alive` stops
  // state updates after unmount. React StrictMode double-mounts safely.
  const alive = useRef(true);
  const healthSeq = useRef(0);
  const logsSeq = useRef(0);
  const logSeq = useRef(0);
  const errorsSeq = useRef(0);
  const backupsSeq = useRef(0);
  const refreshSeq = useRef(0);

  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [health, setHealth] = useState<DiagnosticsHealthDTO | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthUpdatedAt, setHealthUpdatedAt] = useState<number | null>(null);

  const [errorsData, setErrorsData] = useState<DiagnosticsErrorsDTO | null>(null);
  const [errorsLoading, setErrorsLoading] = useState(true);
  const [errorsError, setErrorsError] = useState<string | null>(null);

  const [logFiles, setLogFiles] = useState<DiagnosticsLogListDTO['files']>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState('');
  const [logData, setLogData] = useState<DiagnosticsLogContentDTO | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logFocused, setLogFocused] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const selectedLogRef = useRef('');

  const [backupsData, setBackupsData] = useState<DiagnosticsBackupsDTO | null>(null);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  function beginAction(): void {
    setStatus(null);
    setFailure(null);
  }

  async function loadHealth(): Promise<boolean> {
    const id = ++healthSeq.current;
    setHealthLoading(true);
    setHealthError(null);
    try {
      const data = await api.get<DiagnosticsHealthDTO>('/diagnostics/health');
      if (!alive.current || id !== healthSeq.current) return false;
      setHealth(data);
      setHealthUpdatedAt(Date.now());
      return true;
    } catch (error) {
      if (alive.current && id === healthSeq.current) setHealthError(errorText(error));
      return false;
    } finally {
      if (alive.current && id === healthSeq.current) setHealthLoading(false);
    }
  }

  async function loadErrors(): Promise<boolean> {
    const id = ++errorsSeq.current;
    setErrorsLoading(true);
    setErrorsError(null);
    try {
      const data = await api.get<DiagnosticsErrorsDTO>(`/diagnostics/errors?limit=${ERROR_LIMIT}`);
      if (!alive.current || id !== errorsSeq.current) return false;
      setErrorsData(data);
      return true;
    } catch (error) {
      if (alive.current && id === errorsSeq.current) setErrorsError(errorText(error));
      return false;
    } finally {
      if (alive.current && id === errorsSeq.current) setErrorsLoading(false);
    }
  }

  async function loadLogList(): Promise<DiagnosticsLogListDTO['files'] | null> {
    const id = ++logsSeq.current;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const data = await api.get<DiagnosticsLogListDTO>('/diagnostics/logs');
      if (!alive.current || id !== logsSeq.current) return null;
      setLogFiles(data.files);
      return data.files;
    } catch (error) {
      if (alive.current && id === logsSeq.current) setLogsError(errorText(error));
      return null;
    } finally {
      if (alive.current && id === logsSeq.current) setLogsLoading(false);
    }
  }

  /** Reads one file's tail. `silent` is the 5 s auto-refresh: no spinner, no status announcements. */
  async function loadLogContent(name: string, silent = false): Promise<boolean> {
    const id = ++logSeq.current;
    if (!silent) {
      setLogLoading(true);
      setLogError(null);
    }
    try {
      // No `tailBytes` parameter: the orchestrator applies DIAGNOSTICS_LOG_TAIL.default.
      // Sending an empty value would be coerced to 0 and rejected by the schema.
      const data = await api.get<DiagnosticsLogContentDTO>(`/diagnostics/logs/${encodeURIComponent(name)}`);
      if (!alive.current || id !== logSeq.current || selectedLogRef.current !== name) return false;
      setLogData(data);
      setLogError(null);
      return true;
    } catch (error) {
      if (alive.current && id === logSeq.current && selectedLogRef.current === name) {
        setLogError(errorText(error));
      }
      return false;
    } finally {
      if (!silent && alive.current && id === logSeq.current) setLogLoading(false);
    }
  }

  function chooseLog(name: string): void {
    selectedLogRef.current = name;
    setSelectedLog(name);
    setLogData(null);
    setLogError(null);
    if (!name) setLogLoading(false);
  }

  async function loadBackups(): Promise<boolean> {
    const id = ++backupsSeq.current;
    setBackupsLoading(true);
    setBackupsError(null);
    try {
      const data = await api.get<DiagnosticsBackupsDTO>('/diagnostics/backups');
      if (!alive.current || id !== backupsSeq.current) return false;
      setBackupsData(data);
      return true;
    } catch (error) {
      if (alive.current && id === backupsSeq.current) setBackupsError(errorText(error));
      return false;
    } finally {
      if (alive.current && id === backupsSeq.current) setBackupsLoading(false);
    }
  }

  async function refreshAll(): Promise<void> {
    const cycle = ++refreshSeq.current;
    beginAction();
    setRefreshing(true);
    try {
      const [healthOk, files, errorsOk, backupsOk] = await Promise.all([
        loadHealth(),
        loadLogList(),
        loadErrors(),
        loadBackups(),
      ]);
      if (!alive.current || cycle !== refreshSeq.current) return;
      let logsOk = files !== null;
      if (files !== null) {
        const previous = selectedLogRef.current;
        const next = previous && files.some((file) => file.name === previous) ? previous : (files[0]?.name ?? '');
        if (next !== previous) chooseLog(next);
        logsOk = next ? await loadLogContent(next) : true;
        if (!alive.current || cycle !== refreshSeq.current) return;
      }
      if (healthOk && logsOk && errorsOk && backupsOk) {
        setStatus(`Diagnostics refreshed at ${clockTime(Date.now())}.`);
      } else {
        setFailure(`Some diagnostics could not be refreshed at ${clockTime(Date.now())}. See the affected card for details.`);
      }
    } finally {
      if (alive.current && cycle === refreshSeq.current) setRefreshing(false);
    }
  }

  async function retryHealth(): Promise<void> {
    beginAction();
    const ok = await loadHealth();
    if (!alive.current) return;
    if (ok) setStatus('Health refreshed.');
    else setFailure('Could not refresh health.');
  }

  async function retryErrors(): Promise<void> {
    beginAction();
    const ok = await loadErrors();
    if (!alive.current) return;
    if (ok) setStatus('Recent errors refreshed.');
    else setFailure('Could not refresh recent errors.');
  }

  async function retryBackups(): Promise<void> {
    beginAction();
    const ok = await loadBackups();
    if (!alive.current) return;
    if (ok) setStatus('Backups refreshed.');
    else setFailure('Could not refresh backups.');
  }

  async function retryLogs(): Promise<void> {
    beginAction();
    const files = await loadLogList();
    if (!alive.current) return;
    if (files === null) {
      setFailure('Could not refresh the log file list.');
      return;
    }
    const previous = selectedLogRef.current;
    const next = previous && files.some((file) => file.name === previous) ? previous : (files[0]?.name ?? '');
    if (next !== previous) chooseLog(next);
    const ok = next ? await loadLogContent(next) : true;
    if (!alive.current) return;
    if (ok) setStatus('Log files refreshed.');
    else setFailure('Could not read the selected log.');
  }

  function selectLog(name: string): void {
    if (name === selectedLogRef.current) return;
    beginAction();
    chooseLog(name);
    if (!name) return;
    void loadLogContent(name).then((ok) => {
      if (!alive.current) return;
      if (ok) setStatus(`Showing ${name}.`);
      else setFailure(`Could not read ${name}.`);
    });
  }

  async function refreshLog(): Promise<void> {
    if (!selectedLogRef.current) return;
    beginAction();
    const name = selectedLogRef.current;
    const ok = await loadLogContent(name);
    if (!alive.current) return;
    if (ok) setStatus(`Refreshed ${name}.`);
    else setFailure(`Could not refresh ${name}.`);
  }

  async function createBackup(): Promise<void> {
    beginAction();
    setBackupBusy(true);
    try {
      const result = await api.post<DiagnosticsBackupResult>('/diagnostics/backup', {});
      if (!alive.current) return;
      if (!result.ok) {
        setFailure(`Backup failed: ${result.reason}`);
        return;
      }
      setStatus(`Created backup ${result.name} (${formatBytes(result.size)}).`);
      const ok = await loadBackups();
      if (!alive.current) return;
      if (!ok) setFailure('Backup created, but the backup list could not be refreshed.');
    } catch (error) {
      if (alive.current) setFailure(`Backup failed: ${errorText(error)}`);
    } finally {
      if (alive.current) setBackupBusy(false);
    }
  }

  async function exportArchive(): Promise<void> {
    beginAction();
    setExporting(true);
    try {
      const result = await window.api.exportDiagnostics();
      if (!alive.current) return;
      if (result.ok) {
        setStatus(`Saved diagnostics to ${result.path}.`);
      } else if (result.reason === 'cancelled') {
        setStatus('Export canceled.');
      } else {
        // Fixed reasons from main ("orchestrator unavailable", "write failed", …).
        setFailure(`Export failed: ${result.reason}`);
      }
    } catch (error) {
      if (alive.current) setFailure(`Export failed: ${errorText(error)}`);
    } finally {
      if (alive.current) setExporting(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refreshAll();
    return () => {
      alive.current = false;
    };
  }, []);

  // Auto-refresh is off by default, runs every 5 s, and pauses while either the
  // selector or the log <pre> has focus (so keyboard scrolling is not disturbed).
  useEffect(() => {
    if (!autoRefresh || !selectedLog || logFocused) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void loadLogContent(selectedLog, true).then((ok) => {
        if (!cancelled && !ok) setAutoRefresh(false);
      });
    }, LOG_AUTO_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoRefresh, selectedLog, logFocused]);

  return (
    <div className="flex h-full flex-col" data-testid="diagnostics-page">
      <TopBar title="Diagnostics" subtitle="Health, logs, backups and export">
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={refreshing} onClick={() => void refreshAll()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            data-testid="diagnostics-export"
            size="sm"
            variant="primary"
            disabled={exporting}
            onClick={() => void exportArchive()}
          >
            {exporting ? 'Exporting…' : 'Export diagnostics…'}
          </Button>
        </div>
      </TopBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-3 p-6">
          <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted">
            {status ?? ''}
          </p>
          <p role="alert" className="min-h-5 text-xs text-danger-foreground">
            {failure ?? ''}
          </p>

          <Card data-testid="diagnostics-health" aria-busy={healthLoading} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Component health</h2>
              {health && <Badge tone={healthTone(health.status)}>{health.status}</Badge>}
              <span className="text-xs text-muted-2">
                {healthLoading ? 'Checking…' : health ? `Checked at ${clockTime(healthUpdatedAt)}` : ''}
              </span>
            </div>

            {healthError && (
              <div className="mt-2 flex flex-col items-start gap-1.5 rounded-control border border-danger/40 bg-danger/10 p-2">
                {health && (
                  <p data-testid="diagnostics-health-stale" className="text-xs text-warning-foreground">
                    Showing data from {clockTime(healthUpdatedAt)}; refresh failed.
                  </p>
                )}
                <p className="text-xs text-danger-foreground">{healthError}</p>
                <Button size="sm" disabled={healthLoading} onClick={() => void retryHealth()}>
                  Retry
                </Button>
              </div>
            )}

            {!health && healthLoading && (
              <p className="mt-2 text-xs text-muted">Checking database, logs, backups and providers…</p>
            )}
            {!health && !healthLoading && !healthError && <p className="mt-2 text-xs text-muted">No health data.</p>}

            {health && (
              <>
                <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
                  <dt className="text-muted">Uptime</dt>
                  <dd className="font-mono text-foreground">{formatUptime(health.uptimeSeconds)}</dd>
                  <dt className="text-muted">Memory</dt>
                  <dd className="font-mono text-foreground">
                    RSS {formatBytes(health.memory.rssBytes)} · Heap {formatBytes(health.memory.heapUsedBytes)}
                  </dd>
                  <dt className="text-muted">Versions</dt>
                  <dd className="font-mono text-foreground">
                    App {health.versions.app} · Node {health.versions.node} · Electron{' '}
                    {health.versions.electron ?? 'n/a'}
                  </dd>
                </dl>

                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {HEALTH_COMPONENT_KEYS.map((key) => {
                    const component = health.components[key];
                    return (
                      <li
                        key={key}
                        data-testid={`diagnostics-health-${key}`}
                        className="rounded-control border border-border bg-surface-3 px-2.5 py-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-foreground">{HEALTH_COMPONENT_LABELS[key]}</span>
                          <Badge tone={healthTone(component.status)}>{component.status}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted">{component.detail}</p>
                        {key === 'db' && (
                          <p className="mt-0.5 text-xs text-muted-2">Size {formatBytes(health.components.db.sizeBytes)}</p>
                        )}
                        {key === 'logs' && (
                          <p className="mt-0.5 text-xs text-muted-2">
                            {health.components.logs.fileCount} log file{health.components.logs.fileCount === 1 ? '' : 's'}
                          </p>
                        )}
                        {key === 'backups' && (
                          <p className="mt-0.5 text-xs text-muted-2">
                            {health.components.backups.count} backup{health.components.backups.count === 1 ? '' : 's'}
                            {health.components.backups.latest
                              ? ` · latest ${backupLabel(health.components.backups.latest)}`
                              : ''}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>

          <Card data-testid="diagnostics-errors" aria-busy={errorsLoading} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Recent errors</h2>
              {errorsData && (
                <Badge tone={errorsData.errors.length > 0 ? 'warn' : 'muted'}>{errorsData.errors.length}</Badge>
              )}
              {errorsData && (
                <span className="text-xs text-muted-2">
                  Scanned {errorsData.scannedFiles} log file{errorsData.scannedFiles === 1 ? '' : 's'}
                </span>
              )}
              {errorsLoading && <span className="text-xs text-muted-2">Loading…</span>}
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                disabled={errorsLoading}
                onClick={() => void retryErrors()}
              >
                Refresh errors
              </Button>
            </div>

            {errorsError && (
              <div className="mt-2 flex flex-col items-start gap-1.5 rounded-control border border-danger/40 bg-danger/10 p-2">
                <p className="text-xs text-danger-foreground">{errorsError}</p>
                <Button size="sm" disabled={errorsLoading} onClick={() => void retryErrors()}>
                  Retry
                </Button>
              </div>
            )}

            {errorsData && errorsData.errors.length === 0 && (
              <p className="mt-2 text-xs text-muted">No warnings or errors in the scanned logs.</p>
            )}

            {errorsData && errorsData.errors.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {errorsData.errors.map((error, index) => (
                  <ErrorRow key={`${error.file}:${error.time ?? 'no-time'}:${index}`} error={error} />
                ))}
              </ul>
            )}
          </Card>

          <Card data-testid="diagnostics-log-viewer" className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Log viewer</h2>
              {logData && <Badge tone="muted">{formatBytes(logData.size)}</Badge>}
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  disabled={!selectedLog}
                  onChange={(event) => setAutoRefresh(event.target.checked)}
                  className="h-3.5 w-3.5 shrink-0 appearance-none rounded-[4px] border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                Auto-refresh every 5 s
              </label>
              <Button
                size="sm"
                disabled={!selectedLog || logLoading}
                onClick={() => void refreshLog()}
              >
                {logLoading ? 'Loading…' : 'Refresh log'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted">Redacted for known secrets; treat logs as sensitive.</p>

            <label className="mt-3 flex max-w-xl flex-col gap-1 text-xs font-semibold text-muted">
              <span>Log file</span>
              <Select
                data-testid="diagnostics-log-select"
                aria-label="Log file"
                value={selectedLog}
                disabled={logsLoading || logFiles.length === 0}
                onChange={(event) => selectLog(event.target.value)}
                onFocus={() => setLogFocused(true)}
                onBlur={() => setLogFocused(false)}
              >
                {logFiles.length === 0 && <option value="">{logsLoading ? 'Loading…' : 'No log files'}</option>}
                {logFiles.map((file) => (
                  <option key={file.name} value={file.name}>
                    {logOptionLabel(file)}
                  </option>
                ))}
              </Select>
            </label>
            {logData && (
              <p className="mt-1 text-xs text-muted-2">
                Modified {formatAge(logData.modifiedAt)} · {logData.truncated ? 'tail only' : 'whole file'}
              </p>
            )}

            {logsError && (
              <div className="mt-2 flex flex-col items-start gap-1.5 rounded-control border border-danger/40 bg-danger/10 p-2">
                <p className="text-xs text-danger-foreground">{logsError}</p>
                <Button size="sm" disabled={logsLoading} onClick={() => void retryLogs()}>
                  Retry
                </Button>
              </div>
            )}
            {logError && <p className="mt-2 text-xs text-danger-foreground">Log read failed: {logError}</p>}

            {logData?.truncated && (
              <p data-testid="diagnostics-log-truncated" className="mt-2 text-xs text-warning-foreground">
                Showing the last {formatBytes(DIAGNOSTICS_LOG_TAIL.default)} only; older lines are omitted.
              </p>
            )}
            {!logsLoading && !logsError && logFiles.length === 0 && (
              <p className="mt-2 text-xs text-muted">No log files yet. The orchestrator writes logs as it runs.</p>
            )}

            <pre
              data-testid="diagnostics-log-content"
              tabIndex={0}
              aria-label="Log contents"
              onFocus={() => setLogFocused(true)}
              onBlur={() => setLogFocused(false)}
              className="mt-3 max-h-96 overflow-auto rounded-control border border-border bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              {logLoading && !logData
                ? 'Loading…'
                : logData?.content ||
                  (selectedLog ? 'No log lines in the selected window.' : 'Select a log file to view its tail.')}
            </pre>
          </Card>

          <Card data-testid="diagnostics-backups" aria-busy={backupsLoading} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Database backups</h2>
              {backupsData && (
                <span className="text-xs text-muted-2">
                  {backupsData.backups.length} of {DIAGNOSTICS_MAX_BACKUPS}
                </span>
              )}
              {backupsLoading && <span className="text-xs text-muted-2">Loading…</span>}
              <Button
                data-testid="diagnostics-backup-create"
                className="ml-auto"
                size="sm"
                variant="primary"
                disabled={backupBusy}
                onClick={() => void createBackup()}
              >
                {backupBusy ? 'Creating backup…' : 'Create backup'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted">{backupsData?.restoreNote ?? DIAGNOSTICS_RESTORE_NOTE}</p>
            <p className="mt-1 text-xs text-muted-2">
              Keeps the {DIAGNOSTICS_MAX_BACKUPS} most recent backups; older backups are deleted. The archive is
              redacted but still sensitive.
            </p>

            {backupsError && (
              <div className="mt-2 flex flex-col items-start gap-1.5 rounded-control border border-danger/40 bg-danger/10 p-2">
                <p className="text-xs text-danger-foreground">{backupsError}</p>
                <Button size="sm" disabled={backupsLoading} onClick={() => void retryBackups()}>
                  Retry
                </Button>
              </div>
            )}

            {!backupsLoading && !backupsError && backupsData && backupsData.backups.length === 0 && (
              <p className="mt-2 text-xs text-muted">No backups yet. Create one to snapshot the database.</p>
            )}

            {backupsData && backupsData.backups.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {backupsData.backups.map((backup) => (
                  <li
                    key={backup.name}
                    data-testid="diagnostics-backup-item"
                    className="flex flex-col gap-0.5 rounded-control border border-border bg-surface-3 px-2.5 py-2"
                  >
                    <span className="break-all font-mono text-xs text-foreground">{backup.name}</span>
                    <span className="text-xs text-muted-2">
                      {formatBytes(backup.size)} · {formatAge(backup.modifiedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
