import type { GitHubRepositoryDTO, ProjectDTO } from '@aik/contracts';
import { useState, useEffect, type FormEvent } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextField } from '../ui/field.tsx';
import { ApiRequestError, api } from '../../lib/api.ts';

interface LinkModalProps {
  open: boolean;
  repo: GitHubRepositoryDTO | null;
  onClose: () => void;
  onLinked: (project: ProjectDTO) => void;
}

export function LinkModal({ open, repo, onClose, onLinked }: LinkModalProps) {
  const [localPath, setLocalPath] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [projectName, setProjectName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (repo) {
      setProjectName(repo.name);
      const cleaned = repo.name
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8);
      setProjectKey(cleaned.length >= 2 ? cleaned : 'REPO');
      setError(null);
    }
  }, [repo]);

  if (!repo) return null;

  const handleBrowse = async () => {
    try {
      if (window.api?.pickDirectory) {
        const dir = await window.api.pickDirectory();
        if (dir) setLocalPath(dir);
      }
    } catch {
      // Best-effort directory picker
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!localPath) {
      setError('Please select the local directory of your clone');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const res = await api.post<{ repository: GitHubRepositoryDTO; project: ProjectDTO }>(
        `/github/repositories/${repo.id}/link`,
        {
          localPath: localPath.trim(),
          projectKey: projectKey.trim().toUpperCase(),
          projectName: projectName.trim(),
        }
      );
      onLinked(res.project);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={`Link ${repo.fullName}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Link an existing local clone of{' '}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">{repo.fullName}</span> to AiKanban.
        </p>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label="Local repository directory"
              placeholder="e.g. C:\Users\YourUser\code\my-repo"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              required
            />
          </div>
          <Button type="button" onClick={handleBrowse}>
            Browse…
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Project name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            required
          />
          <TextField
            label="Project key"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
            placeholder="INV"
            required
          />
        </div>

        {error && (
          <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Linking…' : 'Link repository'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
