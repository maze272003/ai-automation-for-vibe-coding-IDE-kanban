import type { ProviderDTO } from '@aik/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from '../../lib/api.ts';
import { Button } from '../ui/button.tsx';

interface Props {
  /** Personal mode uses the user's own OpenCode credentials; the card is not shown there. */
  managed: boolean;
}

function costLabel(p: ProviderDTO): string {
  if (p.costClass === 'free') return 'free';
  if (p.costClass === 'free_limited') return 'free tier';
  if (p.costClass === 'local') return 'local';
  if (p.costClass === 'paid_flat') return 'paid';
  return 'paid per token';
}

/** Honest data-use line (spec PK-1.8): `unknown` is treated as may train until a source is recorded. */
function dataUseLabel(p: ProviderDTO): string {
  if (p.dataUse === 'no_training') return 'Data use verified: no training on your data.';
  if (p.dataUse === 'may_train') return 'Data use verified: the provider may train on your data.';
  return 'Data use not verified.';
}

/** The virtual OpenCode provider id: custom endpoints connect under `custom-<slug>`. */
function opencodeProviderId(p: ProviderDTO): string {
  return p.connectedId ?? p.id;
}

export function ProvidersCard({ managed }: Props) {
  const [providers, setProviders] = useState<ProviderDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const body = await api.get<{ providers: ProviderDTO[] }>('/providers');
      setProviders(body.providers);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    if (!providers) return [];
    const q = query.trim().toLowerCase();
    // The featured providers are shown first; search also reaches model ids and names
    // (a catalog id like `zhipuai` holds no "glm" — only its models do).
    const filtered = q
      ? providers.filter(
          (p) =>
            p.id.includes(q) ||
            p.label.toLowerCase().includes(q) ||
            p.models.some((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
        )
      : providers;
    const featured = filtered.filter((p) => p.featured);
    const rest = filtered.filter((p) => !p.featured);
    return [...featured, ...rest];
  }, [providers, query]);

  if (!managed) {
    return (
      <section className="mt-6" aria-label="Providers">
        <h2 className="font-semibold">Providers</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Personal mode uses your own OpenCode CLI and its credentials.
        </p>
      </section>
    );
  }

  const clearStale = () => {
    setError(null);
    setNotice(null);
  };

  const connect = async (p: ProviderDTO) => {
    setBusy(true);
    clearStale();
    try {
      await api.post('/providers', {
        providerId: p.id,
        ...(apiKey ? { apiKey } : {}),
        ...(p.id === 'custom' && baseUrl ? { baseUrl } : {}),
      });
      setApiKey('');
      setBaseUrl('');
      setRejected((prev) => prev.filter((id) => id !== p.id));
      await window.api.restartOpencode(); // so the fresh provider appears in OpenCode's model list
      await refresh();
      setNotice(`${p.label} is connected.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: ProviderDTO) => {
    setBusy(true);
    clearStale();
    try {
      await api.del(`/providers/${encodeURIComponent(opencodeProviderId(p))}`);
      setRejected((prev) => prev.filter((id) => id !== p.id));
      await window.api.restartOpencode();
      await refresh();
      setNotice(`${p.label} removed.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Only OpenCode speaks the provider's own protocol, so the test runs through it — one real
  // (billed) request with the provider's first unlocked model. The virtual provider id is the
  // connected id (`custom-<slug>` for a custom endpoint, the catalog id otherwise).
  const test = async (p: ProviderDTO) => {
    const model = p.models[0];
    if (!model) {
      setError(`${p.label} exposes no model to test.`);
      return;
    }
    setBusy(true);
    clearStale();
    const result = await window.api.opencodeChat({ providerID: opencodeProviderId(p), id: model.id }, 'Reply with OK.');
    if (result.ok) {
      setRejected((prev) => prev.filter((id) => id !== p.id)); // the key just worked
      setNotice(`${p.label} answered: ${result.text.slice(0, 80)}`);
    } else {
      setError(`${p.label}: ${result.error}`);
      if (/401|403|unauthor|invalid.*key/i.test(result.error)) setRejected((prev) => [...prev, p.id]);
    }
    setBusy(false);
  };

  return (
    <section className="mt-6" aria-label="Providers">
      <h2 className="font-semibold">Providers</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Pick a provider and paste your API key. The key is kept in Windows Credential Manager and is
        never written to the database, the logs or OpenCode.
      </p>
      <input
        type="search"
        aria-label="Search providers"
        placeholder="Search providers"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mt-2 max-w-md rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
      {providers !== null && visible.length === 0 && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No provider matches “{query}”.</p>
      )}
      <ul className="mt-2 flex max-w-2xl flex-col gap-1">
        {visible.map((p) => {
          const untestable = p.connected && p.models.length === 0;
          return (
            <li key={p.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={expanded === p.id}
                  onClick={() => {
                    // A fresh row means a fresh draft: never let one provider's typed key
                    // sit in the field of (and connect against) a different provider.
                    if (expanded !== p.id) {
                      setApiKey('');
                      setBaseUrl('');
                    }
                    setExpanded(expanded === p.id ? null : p.id);
                  }}
                  disabled={Boolean(p.unsupportedReason) || busy}
                  className="flex-1 text-left text-sm font-medium disabled:opacity-50"
                >
                  <span className="block text-sm font-medium">
                    {p.label}
                    <span className="ml-2 text-xs font-normal text-zinc-500">{costLabel(p)}</span>
                    {p.connected && (
                      <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">Connected</span>
                    )}
                    {rejected.includes(p.id) && (
                      <span className="ml-2 text-xs font-normal text-red-600">Key rejected</span>
                    )}
                    {p.unsupportedReason && (
                      <span className="ml-2 text-xs font-normal text-zinc-500">{p.unsupportedReason}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal text-zinc-500">
                    <span>{dataUseLabel(p)}</span>
                    {p.connected && (
                      <span>
                        {' '}· {p.models.length} {p.models.length === 1 ? 'model' : 'models'} unlocked
                        {untestable ? ' — none available to test' : ''}
                      </span>
                    )}
                  </span>
                </button>
                {p.connected && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      disabled={busy || p.models.length === 0}
                      onClick={() => void test(p)}
                      title="Sends one real request through OpenCode — it may be billed."
                    >
                      Test
                    </Button>
                    <Button disabled={busy} onClick={() => void remove(p)}>Remove</Button>
                  </div>
                )}
              </div>
              {expanded === p.id && (
                <div className="mt-2 flex flex-col gap-2">
                  {p.id === 'custom' && (
                    <label className="flex flex-col gap-1 text-sm">
                      Base URL
                      <input
                        type="url"
                        aria-label="Base URL"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="http://127.0.0.1:1234/v1"
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                      />
                    </label>
                  )}
                  {/* The DTO carries no auth flag, so the field shows for everyone; local
                      endpoints simply do not need it, and a blank key is not sent at all. */}
                  <label className="flex flex-col gap-1 text-sm">
                    API key{p.costClass === 'local' ? ' (optional for local endpoints)' : ''}
                    <input
                      type="password"
                      aria-label={`API key for ${p.label}`}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
                    />
                  </label>
                  <div>
                    <Button variant="primary" disabled={busy} onClick={() => void connect(p)}>
                      {busy ? 'Connecting…' : 'Connect'}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
