import type { CheckConfig, CheckDetection, ProjectDTO } from '@aik/contracts';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { TextField } from '../components/ui/field.tsx';
import { Label } from '../components/ui/label.tsx';
import { Select } from '../components/ui/select.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { api, ApiRequestError } from '../lib/api.ts';
import { buildPatch, issuesByField, mergeDetectedChecks, SETTINGS_GROUPS, type SettingsDraft } from '../lib/project-settings.ts';

type ScannerStatus = { found: boolean; path: string; version: string | null };
const booleanFields = new Set(['secretsOnlyVerification', 'cleanroomVerification', 'vulnerabilityScan.enabled', 'autoAcceptPlans', 'allowPaid', 'allowMayTrain', 'webfetch', 'publish', 'remoteMerge', 'requireRemoteChecks']);
const arrayFields = new Set(['protectedPaths', 'shellAllowlist']);
const choices: Record<string, string[]> = { 'vulnerabilityScan.threshold': ['low', 'medium', 'high', 'critical'], mergeMethod: ['merge', 'squash'] };

function valueAt(draft: SettingsDraft, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, draft);
}

function CheckRow({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (checked: boolean) => void; testid: string }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label} data-testid={testid} checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

export function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/settings' });
  const { section } = useSearch({ from: '/projects/$projectId/settings' });
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  const [scannerError, setScannerError] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    let alive = true;
    setDraft(null);
    setError('');
    void (async () => {
      try {
        const loaded = await api.get<ProjectDTO>(`/projects/${projectId}`);
        if (!alive) return;
        setProject(loaded);
        setDraft(loaded.settings);
        if (section === 'verification') {
          const proposal = await api.get<CheckDetection>(`/projects/${projectId}/checks/proposal`);
          if (alive) setDraft((current) => current ? { ...current, checks: mergeDetectedChecks(current.checks, proposal.checks) } : current);
        }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : 'Unable to load settings.'); }
    })();
    return () => { alive = false; };
  }, [projectId, section]);

  useEffect(() => {
    if (draft && section === 'verification') document.getElementById('settings-group-verification')?.scrollIntoView();
  }, [Boolean(draft), section]);

  useEffect(() => {
    let alive = true;
    setScanner(null);
    setScannerError('');
    void api.get<ScannerStatus>(`/projects/${projectId}/vulnerability-scanner`).then(
      (result) => { if (alive) setScanner(result); },
      () => { if (alive) setScannerError('Unable to check scanner availability.'); },
    );
    return () => { alive = false; };
  }, [projectId, saved]);

  function update(path: string, value: unknown) {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      const keys = path.split('.');
      const leaf = keys.pop()!;
      let target = next as unknown as Record<string, unknown>;
      for (const key of keys) {
        target[key] ??= key === 'vulnerabilityScan' ? { enabled: true, threshold: 'high' } : {};
        target = target[key] as Record<string, unknown>;
      }
      if (value === '' && (path === 'vulnerabilityScan.scannerPath' || path === 'vulnerabilityScan.scannerSha256')) delete target[leaf];
      else target[leaf] = value;
      return next;
    });
  }

  async function detect() {
    setDetecting(true);
    setError('');
    try {
      const proposal = await api.get<CheckDetection>(`/projects/${projectId}/checks/proposal`);
      setDraft((current) => current ? { ...current, checks: mergeDetectedChecks(current.checks, proposal.checks) } : current);
      setSaved(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to detect checks.'); }
    finally { setDetecting(false); }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setFieldErrors({});
    setSaved(false);
    try {
      const result = await api.patch<ProjectDTO>(`/projects/${projectId}`, buildPatch(draft));
      setDraft(result.settings);
      setProject(result);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VALIDATION_FAILED') setFieldErrors(issuesByField(err.details));
      setError(err instanceof Error ? err.message : 'Unable to save settings.');
    } finally { setBusy(false); }
  }

  function updateCheck(index: number, patch: Partial<CheckConfig>) {
    if (draft) update('checks', draft.checks.map((check, i) => i === index ? { ...check, ...patch } : check));
  }

  return <div data-testid="project-settings" className="flex h-full flex-col">
    <TopBar title={project ? `${project.key} · Project settings` : 'Project settings'}>
      <Link to="/projects/$projectId" params={{ projectId }}>Back to board</Link>
    </TopBar>
    <div className="space-y-4 overflow-auto p-4">
      {error && <p role="alert" data-testid="settings-error" className="text-danger-foreground">{error}</p>}
      {!draft && !error && <p>Loading settings…</p>}
      {draft && <fieldset disabled={busy} className="space-y-4">
        {SETTINGS_GROUPS.map((group) => <Card key={group.id} id={`settings-group-${group.id}`} data-testid={`settings-group-${group.id}`} className="space-y-4 p-4">
          <h2 className="font-semibold">{group.title}</h2>
          {group.fields.map((field) => {
            const value = valueAt(draft, field.path);
            const testid = `settings-field-${field.path}`;
            const errorId = `${testid}-error`;
            const inlineError = fieldErrors[field.path];
            return <div key={field.path} className="space-y-1">
              {field.path === 'checks' ? <div data-testid={testid} className="space-y-3">
                <Label>Checks</Label>
                {draft.checks.map((check, index) => <div key={index} className="grid grid-cols-2 gap-2 rounded-control border border-border p-3">
                  <TextField label={`Check ${index + 1} key`} data-testid={`settings-field-checks.${index}.key`} value={check.key} error={fieldErrors[`checks.${index}.key`]} onChange={(event) => updateCheck(index, { key: event.target.value })} />
                  <TextField label={`Check ${index + 1} command`} data-testid={`settings-field-checks.${index}.command`} value={check.command} error={fieldErrors[`checks.${index}.command`]} onChange={(event) => updateCheck(index, { command: event.target.value })} />
                  <TextField label={`Check ${index + 1} timeout (seconds)`} type="number" data-testid={`settings-field-checks.${index}.timeoutSec`} value={check.timeoutSec} error={fieldErrors[`checks.${index}.timeoutSec`]} onChange={(event) => updateCheck(index, { timeoutSec: Number(event.target.value) })} />
                  <CheckRow label={`Check ${index + 1} mandatory`} testid={`settings-field-checks.${index}.mandatory`} checked={check.mandatory} onChange={(mandatory) => updateCheck(index, { mandatory })} />
                  <Button onClick={() => update('checks', draft.checks.filter((_, i) => i !== index))}>Remove check {index + 1}</Button>
                </div>)}
                <div className="flex gap-2">
                  <Button onClick={() => update('checks', [...draft.checks, { key: '', command: '', mandatory: true, timeoutSec: 900 }])}>Add check</Button>
                  <Button data-testid="settings-detect-checks" disabled={detecting} onClick={() => void detect()}>{detecting ? 'Detecting…' : 'Detect checks'}</Button>
                </div>
              </div> : booleanFields.has(field.path) ? <CheckRow label={field.label} testid={testid} checked={typeof value === 'boolean' ? value : field.path === 'vulnerabilityScan.enabled'} onChange={(checked) => update(field.path, checked)} />
                : arrayFields.has(field.path) ? <><Label htmlFor={testid}>{field.label} (one per line)</Label><Textarea id={testid} data-testid={testid} value={Array.isArray(value) ? value.join('\n') : ''} aria-invalid={Boolean(inlineError)} aria-describedby={inlineError ? errorId : undefined} onChange={(event) => update(field.path, event.target.value.split('\n').filter((line) => line.trim() !== ''))} /></>
                  : choices[field.path] ? <><Label htmlFor={testid}>{field.label}</Label><Select id={testid} data-testid={testid} value={String(value ?? 'high')} aria-invalid={Boolean(inlineError)} aria-describedby={inlineError ? errorId : undefined} onChange={(event) => update(field.path, event.target.value)}>{choices[field.path]!.map((option) => <option key={option} value={option}>{option}</option>)}</Select></>
                    : <TextField label={field.label} data-testid={testid} type={typeof value === 'number' ? 'number' : 'text'} value={String(value ?? '')} error={inlineError} onChange={(event) => update(field.path, typeof value === 'number' ? Number(event.target.value) : event.target.value)} />}
              {inlineError && (field.path === 'checks' || booleanFields.has(field.path) || arrayFields.has(field.path) || choices[field.path]) && <p role="alert" id={errorId} className="text-xs text-danger-foreground">{inlineError}</p>}
              {field.note && <p className="text-xs text-muted">{field.note}</p>}
            </div>;
          })}
          {group.id === 'verification' && <p data-testid="scanner-status" className="text-sm text-muted">{scanner ? scanner.found ? `Found: ${scanner.version ?? 'version unavailable'}` : `Not found at ${scanner.path}` : scannerError || 'Checking scanner…'}</p>}
        </Card>)}
        <Button variant="primary" data-testid="settings-save" onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </fieldset>}
      {saved && <p role="status" data-testid="settings-saved">Settings saved.</p>}
    </div>
  </div>;
}
