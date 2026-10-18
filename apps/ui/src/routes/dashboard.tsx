import type { ProjectDTO } from '@aik/contracts';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

function CreateProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <form onSubmit={submit} aria-label="Add a local repository" className="mt-6 flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-semibold">Add a local repository</h2>
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <TextField label="Key" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="INV" required />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField label="Repository folder" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} required />
        </div>
        <Button onClick={async () => {
          const dir = await window.api.pickDirectory();
          if (dir) setRepoPath(dir);
        }}>
          Browse…
        </Button>
      </div>
      {error && <p role="alert" data-testid="project-error" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy} className="self-start">Add project</Button>
    </form>
  );
}

export function DashboardPage() {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const system = useSystemState();
  const load = useCallback(async () => {
    try {
      setProjects(await api.get<ProjectDTO[]>('/projects'));
    } catch {
      setProjects([]);
    }
  }, []);
  useEffect(() => {
    if (system.state === 'ready') void load();
  }, [system.state, load]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <ul data-testid="project-list" className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            <Link to="/projects/$projectId" params={{ projectId: String(p.id) }} className="font-medium hover:underline">
              {`${p.key} · ${p.name}`}
            </Link>
            <span className="text-sm text-zinc-500">{p.baseBranch}</span>
            {p.status === 'unavailable' && <Badge tone="warn">unavailable</Badge>}
          </li>
        ))}
      </ul>
      <CreateProjectForm onCreated={load} />
    </div>
  );
}
