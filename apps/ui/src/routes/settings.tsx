import { useEffect, useRef, useState } from 'react';
import { AGENT_MOVEMENT, DEFAULT_OFFICE_PREFERENCES, OFFICE_QUALITY, STATION_STATES } from '@aik/contracts';
import type { AppSettings, OfficePreferences, OpencodeMode, OpencodeModelInfo, OpencodeStatus } from '@aik/contracts';
import { GitHubSettingsCard } from '../components/settings/github-settings.tsx';
import { ProvidersCard } from '../components/settings/providers-card.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Label } from '../components/ui/label.tsx';
import { Select } from '../components/ui/select.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { ConfirmAction } from '../office3d/ui/ConfirmAction.tsx';
import { effectiveStatusColor } from '../office3d/state/customization.ts';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { useTheme } from '../lib/use-theme.ts';
import type { Health } from './root.tsx';

const MODEL_STORAGE_KEY = 'aik:default-model';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', description: 'Bright surfaces for daytime work.' },
  { value: 'dark', label: 'Dark', description: 'Aurora dark surfaces.' },
  { value: 'system', label: 'System', description: 'System follows Windows and switches automatically.' },
] as const satisfies readonly { value: 'light' | 'dark' | 'system'; label: string; description: string }[];

function loadSavedModel(): { providerID: string; id: string } | null {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { providerID: string; id: string }) : null;
  } catch {
    return null;
  }
}

/**
 * A radio group whose inputs are REAL and VISIBLE.
 *
 * `dashboard.spec.ts` calls `getByLabel(/App-managed OpenCode/).check()`, and
 * `check()` only works on a real `<input type="radio">` with an associated
 * label (E6). A `role="radio"` button has no label association and would fail.
 */
function RadioChips<T extends string>({
  name,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-control border px-2.5 py-1.5 text-xs transition-colors',
            value === o.value
              ? 'border-accent/50 bg-accent/10 text-foreground'
              : 'border-border bg-surface-3 text-muted hover:text-foreground',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            className="h-3.5 w-3.5 shrink-0 appearance-none rounded-full border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

interface ModelPickerProps {
  status: OpencodeStatus | null;
  /** The managed/personal decision lives in `SettingsPage` — the Providers card needs it too. */
  mode: OpencodeMode;
  onModeChange: (next: OpencodeMode) => Promise<void>;
}

function ModelPicker({ status, mode, onModeChange }: ModelPickerProps) {
  const [models, setModels] = useState<OpencodeModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [login, setLogin] = useState<{ code: string } | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
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
        const exists = current ? result.models.find((m) => `${m.providerID}/${m.id}` === current) : null;
        if (exists && (exists.providerID !== 'opencode' || !result.models.some((m) => m.providerID !== 'opencode'))) {
          return current;
        }
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
    if (status?.installed || mode === 'personal') {
      void refresh();
      void window.api.opencodeSignedIn().then(setSignedIn, () => setSignedIn(null));
    }
  }, [status?.installed, mode]);

  const switchMode = async (next: OpencodeMode) => {
    if (next === mode || modeBusy) return;
    setModeBusy(true);
    setModelsError(null);
    try {
      await onModeChange(next); // persists through setAppSettings and updates `SettingsPage`
      setSignedIn(null);
      setModels(null);
      setSelected('');
      localStorage.removeItem(MODEL_STORAGE_KEY);
      await refresh();
      void window.api.opencodeSignedIn().then(setSignedIn, () => setSignedIn(null));
    } finally {
      setModeBusy(false);
    }
  };

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

  /** Keeps `localStorage` as the session truth and persists the choice best-effort for the orchestrator. */
  const saveModel = async (providerID: string, id: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerID, id }));
    try {
      await api.put('/settings/default-model', { providerId: providerID, modelId: id });
    } catch {
      // The local choice still applies to this session.
    }
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
    <div data-testid="settings-model" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-2">OpenCode runtime</p>
        <RadioChips
          name="opencode-mode"
          label="OpenCode runtime"
          value={mode}
          disabled={modeBusy}
          options={[
            { value: 'managed', label: `App-managed OpenCode (isolated — pinned ${status?.pinned ?? '…'})` },
            {
              value: 'personal',
              label: 'Use my personal OpenCode CLI (synced with your terminal CLI, login, providers and sessions)',
            },
          ]}
          onChange={(next) => void switchMode(next)}
        />
        {modeBusy && <p className="text-xs text-muted">Switching…</p>}
        {mode === 'personal' && (
          <p className="text-xs text-muted">
            Personal mode uses the <code className="rounded bg-surface-3 px-1 py-px font-mono text-[0.95em]">opencode</code> on your system, syncing sessions, providers, and models with your terminal CLI.
          </p>
        )}
        <p className="text-xs text-muted">Free gateway models need a free OpenCode account, signed in once.</p>
        {!status?.installed && mode === 'managed' && (
          <p className="text-xs text-muted">Install OpenCode above to list models.</p>
        )}
      </div>

      {mode === 'personal' && modelsError && (
        <p role="alert" className="text-sm text-danger-foreground">
          Is `opencode` on your PATH? {modelsError}
        </p>
      )}
      {status?.installed && signedIn === false && (
        <div className="flex flex-col items-start gap-2 rounded-control border border-border bg-surface-3 p-3">
          <p className="text-sm">Sign in to use the free gateway models.</p>
          <Button variant="primary" disabled={login !== null} onClick={() => void startLogin()}>
            {login ? 'Waiting for sign-in…' : 'Sign in to OpenCode (free)'}
          </Button>
          {login && (
            <p className="text-sm" data-testid="opencode-login-code">
              {login.code} — complete it in the browser that just opened.
            </p>
          )}
          {loginError && (
            <p role="alert" className="text-sm text-danger-foreground">
              {loginError}
            </p>
          )}
        </div>
      )}
      {status?.installed && modelsError && (
        <p role="alert" className="text-sm text-danger-foreground">
          {modelsError}
        </p>
      )}
      {status?.installed && models && models.length > 0 && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted">Default model</span>
              <Select
                aria-label="Default model"
                value={selected || `${models[0]?.providerID ?? ''}/${models[0]?.id ?? ''}`}
                onChange={(e) => {
                  setSelected(e.target.value);
                  const [providerID = '', id = ''] = e.target.value.split('/');
                  if (providerID && id) void saveModel(providerID, id);
                }}
                className="max-w-md"
              >
                {models.map((m) => (
                  <option key={`${m.providerID}/${m.id}`} value={`${m.providerID}/${m.id}`}>
                    {m.name} · {m.providerID}/{m.id}{m.free ? ' · free' : ''}
                  </option>
                ))}
              </Select>
            </Label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted">Test prompt</span>
              <Textarea
                aria-label="Test prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="max-w-md"
                rows={2}
              />
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy || (!selected && models.length === 0)} onClick={() => void send()}>
              {busy ? 'Asking…' : 'Send test prompt'}
            </Button>
            <Button disabled={busy} onClick={() => void refresh()}>
              Refresh models
            </Button>
          </div>
          {reply && (
            <p data-testid="model-test-reply" className="max-w-md whitespace-pre-wrap rounded-control bg-surface-3 p-2 text-sm">
              {reply}
            </p>
          )}
        </>
      )}
    </div>
  );
}

const CHECKBOX_CLASS =
  'h-3.5 w-3.5 shrink-0 appearance-none rounded-[4px] border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const RADIO_CLASS =
  'h-3.5 w-3.5 shrink-0 appearance-none rounded-full border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const VIEW_OPTIONS = [['overview', 'Overview'], ['last-room', 'Last room'], ['walk', 'Walk']] as const;
const SCREEN_OPTIONS = [['kanban', 'Kanban wall'], ['activity', 'Activity monitor'], ['runs', 'Runs monitor']] as const;
const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

function RadioRow<T extends string>({ name, label, options, value, onChange, testid }: {
  name: string; label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; testid: string;
}) {
  return (
    <fieldset data-testid={testid}>
      <legend className="text-xs text-muted">{label}</legend>
      <div className="mt-1 flex flex-wrap gap-4">
        {options.map(([v, text]) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="radio" name={name} value={v} aria-label={`${label}: ${text}`} checked={value === v} onChange={() => onChange(v)} className={RADIO_CLASS} />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RangeRow({ label, min, max, step, value, onChange, testid }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; testid: string;
}) {
  return (
    <label className="flex items-center gap-3 text-sm text-foreground">
      <span className="w-40 text-xs text-muted">{label}</span>
      <input type="range" data-testid={testid} aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="w-10 font-mono text-xs">{value}</span>
    </label>
  );
}

function CheckRow({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input type="checkbox" data-testid={testid} aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className={CHECKBOX_CLASS} />
      {label}
    </label>
  );
}

export function SettingsPage() {
  const { preference, resolved, setPreference, toggle } = useTheme();
  const [health, setHealth] = useState<Health | null>(null);
  const [opencode, setOpencode] = useState<OpencodeStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [mode, setMode] = useState<OpencodeMode>('managed');
  const [office, setOffice] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [office3d, setOffice3d] = useState<OfficePreferences>(DEFAULT_OFFICE_PREFERENCES);
  const [compactOpen, setCompactOpen] = useState(false);
  const settingsRef = useRef<AppSettings | null>(null);
  settingsRef.current = settings;
  useEffect(() => {
    void api.get<Health>('/health').then(setHealth, () => setHealth(null));
    void window.api.opencodeStatus().then(setOpencode, () => setOpencode(null));
    void window.api.getAppSettings().then((s) => {
      setSettings(s);
      setOffice3d(s.office3d ?? DEFAULT_OFFICE_PREFERENCES);
      setMode(s.opencodeMode);
      setOffice(s.agentOffice);
    }, () => undefined);
  }, []);

  /** The managed/personal decision is shared by the model picker and the Providers card. */
  const changeMode = async (next: OpencodeMode) => {
    if (next === mode) return;
    setMode(next);
    const saved = await window.api.setAppSettings({ ...settings, opencodeMode: next, agentOffice: office } as AppSettings);
    setSettings(saved);
    setMode(saved.opencodeMode);
    setOffice(saved.agentOffice);
  };

  /** Toggling starts/stops the bundled office server and restarts the orchestrator (main side). */
  const changeOffice = async (next: boolean) => {
    if (next === office) return;
    setOffice(next);
    const saved = await window.api.setAppSettings({ ...settings, opencodeMode: mode, agentOffice: next } as AppSettings);
    setSettings(saved);
    setMode(saved.opencodeMode);
    setOffice(saved.agentOffice);
  };

  /** 3D office preferences apply immediately; the saved copy comes back from the desktop main process. */
  const changeOffice3d = (patch: Partial<OfficePreferences>) => {
    const next = { ...office3d, ...patch };
    setOffice3d(next);
    void window.api.setAppSettings({ ...settingsRef.current, office3d: next } as AppSettings).then((saved) => setSettings(saved), () => undefined);
  };

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    const result = await window.api.installOpencode();
    if (!result.ok) setInstallError(result.error);
    setOpencode(await window.api.opencodeStatus());
    setInstalling(false);
  };

  const opencodeLabel = !opencode
    ? '…'
    : opencode.installed
      ? opencode.matchesPin
        ? opencode.version
        : `${opencode.version} (expected ${opencode.pinned})`
      : 'not installed';

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Settings" subtitle="Appearance, runtime and diagnostics" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
          <Card data-testid="settings-appearance" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
            <p className="mt-1 text-xs text-muted">The theme applies instantly and is remembered on this device.</p>
            <fieldset data-testid="theme-preference" className="mt-3">
              <legend className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-2">Theme</legend>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {THEME_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-control border px-2.5 py-2 text-xs transition-colors',
                      preference === option.value
                        ? 'border-accent/50 bg-accent/10 text-foreground'
                        : 'border-border bg-surface-3 text-muted hover:text-foreground',
                    )}
                  >
                    <input
                      type="radio"
                      name="theme-preference"
                      value={option.value}
                      aria-label={option.label}
                      checked={preference === option.value}
                      onChange={() => setPreference(option.value)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 appearance-none rounded-full border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span>{option.label}</span>
                      <span className="text-muted-2">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={toggle}>
                Switch to {resolved === 'dark' ? 'light' : 'dark'} theme
              </Button>
            </div>
          </Card>

          <Card data-testid="settings-runtime" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">Agent runtime</h2>
            <p className="mt-1 text-xs text-muted">Choose how the orchestrator runs OpenCode and which model it defaults to.</p>
            <div className="mt-3">
              <ModelPicker status={opencode} mode={mode} onModeChange={changeMode} />
            </div>
          </Card>

          <Card data-testid="settings-office" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">Agent office</h2>
            <p className="mt-1 text-xs text-muted">
              Show every running agent as a pixel-art character in an office view. Bundled Pixel
              Agents (MIT) runs locally on 127.0.0.1 and is embedded read-only. Enabling it also
              turns on Pixel Agents' global "Watch all sessions" setting so this app's agents
              appear; the orchestrator restarts once to activate it.
            </p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid="office-toggle"
                checked={office}
                onChange={(e) => void changeOffice(e.target.checked)}
                className="h-3.5 w-3.5 shrink-0 appearance-none rounded-[4px] border border-border-strong bg-surface-2 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              Show agents in the office view
            </label>
          </Card>

          <Card data-testid="settings-office3d" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">3D office</h2>
            <p className="mt-1 text-xs text-muted">Controls for the 3D office view: navigation, graphics and how stations are shown.</p>
            <div className="mt-3 flex flex-col gap-3">
              <RadioRow name="office3d-view" label="Default view" testid="office3d-default-view" options={VIEW_OPTIONS} value={office3d.defaultView} onChange={(v) => changeOffice3d({ defaultView: v })} />
              <CheckRow label="Enable walk mode" testid="office3d-walk" checked={office3d.walkEnabled} onChange={(v) => changeOffice3d({ walkEnabled: v })} />
              <RangeRow label="Mouse sensitivity" testid="office3d-sensitivity" min={0.2} max={3} step={0.1} value={office3d.mouseSensitivity} onChange={(v) => changeOffice3d({ mouseSensitivity: v })} />
              <RangeRow label="Walk speed" testid="office3d-walk-speed" min={0.5} max={4} step={0.1} value={office3d.walkSpeed} onChange={(v) => changeOffice3d({ walkSpeed: v })} />
              <RangeRow label="Fly speed" testid="office3d-fly-speed" min={0.25} max={3} step={0.05} value={office3d.flySpeed} onChange={(v) => changeOffice3d({ flySpeed: v })} />
              <RadioRow name="office3d-quality" label="Graphics quality" testid="office3d-quality" options={OFFICE_QUALITY.map((q) => [q, cap(q)] as const)} value={office3d.quality} onChange={(v) => changeOffice3d({ quality: v })} />
              <RadioRow name="office3d-movement" label="Agent movement" testid="office3d-movement" options={AGENT_MOVEMENT.map((m) => [m, cap(m)] as const)} value={office3d.agentMovement} onChange={(v) => changeOffice3d({ agentMovement: v })} />
              <CheckRow label="Show archived rooms" testid="office3d-archived" checked={office3d.showArchived} onChange={(v) => changeOffice3d({ showArchived: v })} />
              <fieldset>
                <legend className="text-xs text-muted">Default screens</legend>
                <div className="mt-1 flex flex-wrap gap-4">
                  {SCREEN_OPTIONS.map(([k, text]) => (
                    <CheckRow key={k} label={text} testid={`office3d-screen-${k}`} checked={office3d.screens[k]} onChange={(v) => changeOffice3d({ screens: { ...office3d.screens, [k]: v } })} />
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="text-xs text-muted">Status colours</legend>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {STATION_STATES.map((st) => (
                    <label key={st} className="flex items-center gap-1.5 text-xs text-foreground">
                      <input
                        type="color"
                        data-testid={`office3d-color-${st}`}
                        aria-label={`Status colour ${st}`}
                        value={effectiveStatusColor(st, office3d)}
                        onChange={(e) => changeOffice3d({ statusColors: { ...office3d.statusColors, [st]: e.target.value } })}
                      />
                      {st}
                    </label>
                  ))}
                  <Button variant="secondary" size="sm" data-testid="office3d-reset-colors" onClick={() => changeOffice3d({ statusColors: {} })}>
                    Reset colours
                  </Button>
                </div>
              </fieldset>
              <div>
                <Button variant="secondary" size="sm" data-testid="office3d-compact" onClick={() => setCompactOpen(true)}>
                  Compact layout
                </Button>
              </div>
            </div>
            <ConfirmAction
              open={compactOpen}
              title="Compact layout"
              message="Rooms will move to close gaps. Continue?"
              confirmLabel="Compact layout"
              onConfirm={() => api.post('/office/rooms/compact', {}).then(() => undefined)}
              onClose={() => setCompactOpen(false)}
            />
          </Card>

          <Card data-testid="settings-about" className="p-4">
            <h2 className="text-sm font-semibold text-foreground">About</h2>
            <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted">Data folder</dt>
              <dd data-testid="data-dir" className="break-all font-mono text-xs">{health?.dataDir ?? '…'}</dd>
              <dt className="text-muted">App version</dt>
              <dd className="font-mono text-xs">{health?.versions.app ?? '…'}</dd>
              <dt className="text-muted">Electron</dt>
              <dd className="font-mono text-xs">{health?.versions.electron ?? '…'}</dd>
              <dt className="text-muted">OpenCode</dt>
              <dd className="flex flex-wrap items-center gap-3">
                <span data-testid="opencode-status" className="font-mono text-xs">{opencodeLabel}</span>
                {opencode && !opencode.matchesPin && (
                  <Button size="sm" disabled={installing} onClick={() => void install()}>
                    {installing ? 'Installing…' : opencode.installed ? 'Repair install' : 'Install OpenCode (one-time download)'}
                  </Button>
                )}
              </dd>
            </dl>
            {installError && (
              <p role="alert" className="mt-2 text-sm text-danger-foreground" data-testid="opencode-error">
                {installError}
              </p>
            )}
          </Card>

          <ProvidersCard managed={mode === 'managed'} />
          <GitHubSettingsCard />
        </div>
      </div>
    </div>
  );
}
