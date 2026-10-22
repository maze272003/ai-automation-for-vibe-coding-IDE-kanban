import type {
  DeviceCodeStartDTO,
  DeviceFlowPollDTO,
  GitHubConnectionDTO,
  GitHubSettingsDTO,
} from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button } from '../ui/button.tsx';

export function GitHubSettingsCard() {
  const [settings, setSettings] = useState<GitHubSettingsDTO | null>(null);
  const [connection, setConnection] = useState<GitHubConnectionDTO | null>(null);
  const [clientIdInput, setClientIdInput] = useState('');
  const [savingClientId, setSavingClientId] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  // Device flow state
  const [deviceFlow, setDeviceFlow] = useState<DeviceCodeStartDTO | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const [s, c] = await Promise.all([
        api.get<GitHubSettingsDTO>('/github/settings'),
        api.get<GitHubConnectionDTO | null>('/github/connection'),
      ]);
      setSettings(s);
      if (s.clientId) setClientIdInput(s.clientId);
      setConnection(c);
    } catch {
      // Ignored if API not ready yet
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const saveClientId = async () => {
    setSavingClientId(true);
    setSaveError(null);
    try {
      const updated = await api.patch<GitHubSettingsDTO>('/github/settings', {
        clientId: clientIdInput.trim(),
      });
      setSettings(updated);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save Client ID');
    } finally {
      setSavingClientId(false);
    }
  };

  const startConnect = async () => {
    setPollError(null);
    setCopied(false);
    try {
      const start = await api.post<DeviceCodeStartDTO>('/github/connection/device-start', {});
      setDeviceFlow(start);
      setPolling(true);

      // Open external browser with the verification URI
      if (window.open) {
        window.open(start.verificationUri, '_blank');
      }

      schedulePoll(start.sessionToken, start.interval);
    } catch (err: unknown) {
      setPollError(err instanceof Error ? err.message : 'Failed to start GitHub device flow');
    }
  };

  const schedulePoll = (sessionToken: string, intervalSeconds: number) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      try {
        const poll = await api.post<DeviceFlowPollDTO>('/github/connection/device-poll', {
          sessionToken,
        });

        if (poll.status === 'complete' && poll.connection) {
          setConnection(poll.connection);
          setDeviceFlow(null);
          setPolling(false);
        } else if (poll.status === 'pending') {
          schedulePoll(sessionToken, poll.interval ?? intervalSeconds);
        } else if (poll.status === 'slow_down') {
          schedulePoll(sessionToken, poll.interval ?? intervalSeconds + 5);
        } else if (poll.status === 'access_denied') {
          setPollError(poll.error ?? 'Access was denied by the user on GitHub.');
          setPolling(false);
        } else if (poll.status === 'expired') {
          setPollError(poll.error ?? 'Device code expired. Please start over.');
          setPolling(false);
        } else {
          setPollError(poll.error ?? 'Authentication failed.');
          setPolling(false);
        }
      } catch (err: unknown) {
        setPollError(err instanceof Error ? err.message : 'Error polling GitHub status');
        setPolling(false);
      }
    }, Math.max(intervalSeconds, 1) * 1000);
  };

  const cancelConnect = () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setDeviceFlow(null);
    setPolling(false);
    setPollError(null);
  };

  const disconnect = async () => {
    if (!confirm('Disconnect GitHub account?')) return;
    try {
      await api.post('/github/connection/disconnect', {});
      await load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to disconnect');
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  const isConnected = connection?.status === 'connected';

  return (
    <section className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800" aria-label="GitHub Integration">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">GitHub Integration</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Connect your personal GitHub App to clone repositories, create pull requests, and verify CI runs.
          </p>
        </div>
        {isConnected && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Connected
          </span>
        )}
      </div>

      {/* Connected Account Display */}
      {isConnected ? (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                Signed in as <span className="font-semibold text-indigo-600 dark:text-indigo-400">@{connection.login}</span>
              </p>
              {connection.accessExpiresAt && (
                <p className="text-xs text-zinc-500">
                  Token expires: {new Date(connection.accessExpiresAt).toLocaleString()} (auto-refreshed)
                </p>
              )}
            </div>
            <Button variant="danger" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {/* Registration Guide Accordion */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left text-sm font-medium text-indigo-600 dark:text-indigo-400"
              onClick={() => setGuideOpen(!guideOpen)}
            >
              <span>{guideOpen ? '▾ Hide Registration Guide' : '▸ Step 1: Register your personal GitHub App (Guided Checklist)'}</span>
            </button>

            {guideOpen && (
              <div className="mt-3 space-y-3 text-xs text-zinc-600 dark:text-zinc-400">
                <p>
                  1. Go to{' '}
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-indigo-600 underline dark:text-indigo-400"
                  >
                    GitHub Settings → Developer Settings → GitHub Apps → New GitHub App
                  </a>
                  .
                </p>
                <div className="rounded bg-zinc-100 p-2.5 dark:bg-zinc-900">
                  <p className="font-medium text-zinc-800 dark:text-zinc-200">Required Configuration:</p>
                  <ul className="mt-1.5 list-disc pl-4 space-y-1">
                    <li><strong>GitHub App name:</strong> e.g. <code>AI Kanban ({settings?.clientId ? 'Configured' : 'Personal'})</code></li>
                    <li><strong>Homepage URL:</strong> <code>https://github.com</code></li>
                    <li><strong>Webhook:</strong> Uncheck <em>Active</em> (webhooks disabled)</li>
                    <li><strong>Device flow:</strong> Check <strong>Enable Device Flow</strong></li>
                  </ul>
                  <p className="mt-2 font-medium text-zinc-800 dark:text-zinc-200">Repository Permissions:</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    <li>Metadata: <strong>Read-only</strong> (mandatory)</li>
                    <li>Contents: <strong>Read and write</strong></li>
                    <li>Pull requests: <strong>Read and write</strong></li>
                    <li>Checks: <strong>Read-only</strong></li>
                    <li>Commit statuses: <strong>Read-only</strong></li>
                    <li><strong className="text-amber-600 dark:text-amber-400">Workflows:</strong> <em>Do NOT grant</em> (safety guard)</li>
                  </ul>
                </div>
                <p>2. Click <strong>Create GitHub App</strong>, then copy the <strong>Client ID</strong> (starts with <code>Iv1.</code> or <code>Iv23</code>).</p>
              </div>
            )}
          </div>

          {/* Client ID Configuration Input */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <h3 className="text-sm font-medium">Step 2: Configure Client ID</h3>
            <p className="text-xs text-zinc-500">
              Paste the public Client ID from your GitHub App settings. No client secret is needed or supported.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="GitHub Client ID"
                type="text"
                placeholder="Iv1.xxxxxxxxxxxxxxxx or Iv23xxxxxxxxxxxxxxxx"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 font-mono"
              />
              <Button
                variant="primary"
                disabled={savingClientId || !clientIdInput.trim() || clientIdInput === settings?.clientId}
                onClick={() => void saveClientId()}
              >
                {savingClientId ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {saveError && <p className="mt-1 text-xs text-red-600">{saveError}</p>}
          </div>

          {/* Connect Button and Device Code Modal */}
          {settings?.clientId && !deviceFlow && (
            <div className="pt-2">
              <Button variant="primary" onClick={() => void startConnect()}>
                Connect GitHub Account
              </Button>
            </div>
          )}

          {deviceFlow && (
            <div className="rounded-lg border-2 border-indigo-500/40 bg-indigo-50/50 p-5 dark:bg-indigo-950/20">
              <h4 className="font-semibold text-zinc-900 dark:text-zinc-100">Authorize on GitHub</h4>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Enter this one-time code on the GitHub authorization page:
              </p>
              <div className="mt-3 flex items-center gap-3">
                <span className="rounded bg-white px-3.5 py-1.5 font-mono text-xl font-bold tracking-wider text-indigo-600 shadow-sm dark:bg-zinc-900 dark:text-indigo-400">
                  {deviceFlow.userCode}
                </span>
                <Button onClick={() => void copyCode(deviceFlow.userCode)}>
                  {copied ? 'Copied!' : 'Copy Code'}
                </Button>
                <a
                  href={deviceFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Open GitHub Page
                </a>
                <Button variant="secondary" onClick={cancelConnect}>
                  Cancel
                </Button>
              </div>

              {polling && (
                <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                  <span className="inline-block h-2 w-2 animate-ping rounded-full bg-indigo-500" />
                  Waiting for you to complete authorization on GitHub…
                </p>
              )}
              {pollError && <p className="mt-2 text-xs text-red-600">{pollError}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
