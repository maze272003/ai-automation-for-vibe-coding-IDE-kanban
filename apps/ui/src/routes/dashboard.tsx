import type { ProjectDTO } from '@aik/contracts';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RepositoryBrowser } from '../components/github/repository-browser.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { useSystemState } from '../lib/events.ts';

/** Best-effort project identity from a repository folder path; the form fields stay editable. */
function suggestIdentity(folder: string): { name: string; key: string } {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  const base = parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
  const cleaned = base.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 10);
  return { name: base, key: cleaned.length >= 2 ? cleaned : '' };
}

function CreateProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyRepoPath = (v: string) => {
    setRepoPath(v);
    const suggestion = suggestIdentity(v);
    if (!name && suggestion.name) setName(suggestion.name);
    if (!key && suggestion.key) setKey(suggestion.key);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/projects', { name, key, repoPath });
      setName('');
      setKey('');
      setRepoPath('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4 border-dashed p-4">
      <h2 className="text-sm font-semibold text-foreground">Add a local repository</h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label="Key" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="INV" required />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextField label="Repository folder" value={repoPath} onChange={(e) => applyRepoPath(e.target.value)} required />
          </div>
          <Button
            onClick={async () => {
              const dir = await window.api.pickDirectory();
              if (dir) applyRepoPath(dir);
            }}
          >
            Browse…
          </Button>
        </div>
        {error && (
          <p role="alert" data-testid="project-error" className="text-sm text-danger-foreground">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="self-start">
          Add project
        </Button>
      </form>
    </Card>
  );
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [activeTab, setActiveTab] = useState<'local' | 'github'>('local');
  const [isGitHubConnected, setIsGitHubConnected] = useState(false);
  const system = useSystemState();

  const load = useCallback(async () => {
    try {
      setProjects(await api.get<ProjectDTO[]>('/projects'));
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (system.state !== 'ready') return;
    void load();
    void api
      .get<{ status?: string } | null>('/github/connection')
      .then((conn) => {
        if (conn && conn.status === 'connected') {
          setIsGitHubConnected(true);
        }
      })
      .catch(() => {});
  }, [system.state, load]);

  return (
    <div className="flex h-full flex-col">
      {/*
        E5: exactly one heading named "Projects". The subtitle is a sibling paragraph,
        not part of the h1, so the heading's accessible name stays exactly "Projects".
        The sidebar's "Projects" is a link, so it does not collide.
      */}
      <TopBar title="Projects" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-sm text-muted">
              Local repositories this orchestrator can plan, implement and merge into.
            </p>
            <div
              role="group"
              aria-label="Project source"
              className="inline-flex items-center gap-1 rounded-control border border-glass-border bg-surface-2/60 p-1"
            >
              <button
                type="button"
                aria-pressed={activeTab === 'local'}
                onClick={() => setActiveTab('local')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-xs font-semibold transition-colors',
                  activeTab === 'local'
                    ? 'bg-accent-soft text-accent-soft-foreground'
                    : 'text-muted hover:bg-surface-2 hover:text-foreground',
                )}
              >
                Local Projects ({projects.length})
              </button>
              <button
                type="button"
                aria-pressed={activeTab === 'github'}
                onClick={() => setActiveTab('github')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-xs font-semibold transition-colors',
                  activeTab === 'github'
                    ? 'bg-accent-soft text-accent-soft-foreground'
                    : 'text-muted hover:bg-surface-2 hover:text-foreground',
                )}
              >
                GitHub Repositories
                {isGitHubConnected && <Badge tone="ok">connected</Badge>}
              </button>
            </div>
          </div>

          {activeTab === 'local' ? (
            <>
              {/*
                E4: `project-list` must exist exactly once and contain both the full
                "KEY · name" label and the base branch.
              */}
              <div data-testid="project-list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {projects.length === 0 ? (
                  <p className="col-span-full rounded-panel border border-dashed border-glass-border bg-glass/40 p-6 text-sm text-muted">
                    No local repositories yet. Add one below to start planning.
                  </p>
                ) : (
                  projects.map((p) => (
                    <Card key={p.id} data-testid={`project-card-${p.key}`} className="p-4 transition-colors hover:border-border-strong">
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: String(p.id) }}
                        className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground hover:underline"
                      >
                        <span className="rounded-[5px] border border-accent/25 bg-accent-soft px-1.5 py-px font-mono text-[10px] font-bold text-accent-soft-foreground">
                          {p.key}
                        </span>
                        <span className="truncate">{` · ${p.name}`}</span>
                      </Link>
                      <p className="mt-2 truncate font-mono text-xs text-muted-2" title={p.repoPath}>
                        {p.repoPath}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <Badge tone="muted">{p.baseBranch}</Badge>
                        {p.status === 'unavailable' ? <Badge tone="warn">unavailable</Badge> : <Badge tone="ok">ready</Badge>}
                      </div>
                    </Card>
                  ))
                )}
              </div>

              <CreateProjectForm onCreated={load} />
            </>
          ) : (
            <RepositoryBrowser onProjectCreated={load} />
          )}
        </div>
      </div>
    </div>
  );
}
