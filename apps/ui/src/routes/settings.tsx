import { useEffect, useState } from 'react';
import type { OpencodeModelInfo, OpencodeStatus } from '@aik/contracts';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { applyTheme, loadTheme, type Theme } from '../lib/theme.ts';
import type { Health } from './root.tsx';

const MODEL_STORAGE_KEY = 'aik:default-model';

function loadSavedModel(): { providerID: string; id: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { providerID: string; id: string }) : null;
  } catch {
    return null;
  }
}

function ModelPicker({ status }: { status: OpencodeStatus | null }) {
  const [models, setModels] = useState<OpencodeModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [login, setLogin] = useState<{ code: string } | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => {
    const saved = loadSavedModel();
    return saved ? `${saved.providerID}/${saved.id}` : '';
  });
  const [prompt, setPrompt] = useState('Reply with one short sentence about yourself.');
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setModelsError(null);
    const result = await window.api.opencodeModels();
    if (result.ok) {
      setModels(result.models);
      setSelected((current) => {
        if (current) return current;
        const first = result.models[0];
        if (!first) return current;
        localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID: first.providerID, id: first.id }));
        return `${first.providerID}/${first.id}`;
      });
    } else {
      setModels(null);
      setModelsError(result.error);
    }
  };

  useEffect(() => {
    if (status?.installed) {
      void refresh();
      void window.api.opencodeSignedIn().then(setSignedIn, () => setSignedIn(null));
    }
  }, [status?.installed]);

  const startLogin = async () => {
    setLoginError(null);
    const start = await window.api.opencodeLoginStart();
    if (!start.ok) {
      setLoginError(start.error);
      return;
    }
    setLogin({ code: start.code });
    const done = await window.api.opencodeLoginWait();
    setLogin(null);
    if (!done.ok) {
      setLoginError(done.error);
      return;
    }
    setSignedIn(true);
  };

  const send = async () => {
    const [providerID = '', id = ''] = selected.split('/');
    if (!providerID || !id) return;
    setBusy(true);
    setReply(null);
    const result = await window.api.opencodeChat({ providerID, id }, prompt);
    setReply(result.ok ? result.text : `✗ ${result.error}`);
    setBusy(false);
  };

  return (
    <section className="mt-6">
      <h2 className="font-semibold">Default model</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Served by the app's managed OpenCode — free gateway models need a free OpenCode account, signed in once.</p>
      {!status?.installed && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Install OpenCode above to list models.</p>}
      {status?.installed && signedIn === false && (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-sm">Sign in to use the free gateway models.</p>
          <Button variant="primary" disabled={login !== null} onClick={() => void startLogin()}>
            {login ? 'Waiting for sign-in…' : 'Sign in to OpenCode (free)'}
          </Button>
          {login && <p className="text-sm" data-testid="opencode-login-code">{login.code} — complete it in the browser that just opened.</p>}
          {loginError && <p role="alert" className="text-sm text-red-600">{loginError}</p>}
        </div>
      )}
      {status?.installed && modelsError && (
        <p role="alert" className="mt-2 text-sm text-red-600">{modelsError}</p>
      )}
      {status?.installed && models && models.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Default model
            <select
              aria-label="Default model"
              value={selected || `${models[0]?.providerID ?? ''}/${models[0]?.id ?? ''}`}
              onChange={(e) => {
                setSelected(e.target.value);
                const [providerID = '', id = ''] = e.target.value.split('/');
                localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID, id }));
              }}
              className="max-w-md rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {models.map((m) => (
                <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                  {m.name} · {m.providerID}/{m.id}{m.free ? ' · free' : ''}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Test prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="max-w-md rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy || !selected && models.length === 0} onClick={() => void send()}>
              {busy ? 'Asking…' : 'Send test prompt'}
            </Button>
            <Button disabled={busy} onClick={() => void refresh()}>Refresh models</Button>
          </div>
          {reply && (
            <p data-testid="model-test-reply" className="max-w-md whitespace-pre-wrap rounded-md bg-zinc-100 p-2 text-sm dark:bg-zinc-900">
              {reply}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  const [health, setHealth] = useState<Health | null>(null);
  const [opencode, setOpencode] = useState<OpencodeStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<Health>('/health').then(setHealth, () => setHealth(null));
    void window.api.opencodeStatus().then(setOpencode, () => setOpencode(null));
  }, []);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    const result = await window.api.installOpencode();
    if (!result.ok) setInstallError(result.error);
    setOpencode(await window.api.opencodeStatus());
    setInstalling(false);
  };

  const opencodeLabel = !opencode ? '…' : opencode.installed ? (opencode.matchesPin ? opencode.version : `${opencode.version} (expected ${opencode.pinned})`) : 'not installed';
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="mt-4">
        <h2 className="font-semibold">Theme</h2>
        <Button
          className="mt-2"
          onClick={() => {
            const next: Theme = theme === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            setTheme(next);
          }}
        >
          Switch to {theme === 'dark' ? 'light' : 'dark'} theme
        </Button>
      </section>
      <section className="mt-6" aria-label="About">
        <h2 className="font-semibold">About</h2>
        <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-1 text-sm">
          <dt>Data folder</dt>
          <dd data-testid="data-dir">{health?.dataDir ?? '…'}</dd>
          <dt>App version</dt>
          <dd>{health?.versions.app ?? '…'}</dd>
          <dt>Electron</dt>
          <dd>{health?.versions.electron ?? '…'}</dd>
          <dt>OpenCode</dt>
          <dd className="flex items-center gap-3">
            <span data-testid="opencode-status">{opencodeLabel}</span>
            {opencode && !opencode.matchesPin && (
              <Button disabled={installing} onClick={() => void install()}>
                {installing ? 'Installing…' : opencode.installed ? 'Repair install' : 'Install OpenCode (one-time download)'}
              </Button>
            )}
          </dd>
        </dl>
        {installError && (
          <p role="alert" className="mt-2 text-sm text-red-600" data-testid="opencode-error">
            {installError}
          </p>
        )}
      </section>
      <ModelPicker status={opencode} />
    </div>
  );
}
