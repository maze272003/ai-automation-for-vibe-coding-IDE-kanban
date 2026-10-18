import { useEffect, useState } from 'react';
import type { OpencodeStatus } from '@aik/contracts';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { applyTheme, loadTheme, type Theme } from '../lib/theme.ts';
import type { Health } from './root.tsx';

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
    </div>
  );
}
