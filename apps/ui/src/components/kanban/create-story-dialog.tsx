// apps/ui/src/components/kanban/create-story-dialog.tsx
import type { Priority } from '@aik/contracts';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { PRIORITY_THEME } from '../../lib/status-theme.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Label } from '../ui/label.tsx';
import { TextArea, TextField } from '../ui/field.tsx';

export function CreateStoryDialog({ open, projectId, onClose, onCreated }: { open: boolean; projectId: number; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [labels, setLabels] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/projects/${projectId}/stories`, {
        title,
        description,
        priority,
        acceptanceCriteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean),
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setTitle('');
      setDescription('');
      setCriteria('');
      setLabels('');
      setError(null);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.reason : String(err));
    }
  };

  return (
    <Dialog open={open} title="New story" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextArea label="Acceptance criteria (one per line)" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        <TextField label="Labels (comma separated)" value={labels} onChange={(e) => setLabels(e.target.value)} />
        <div className="flex flex-col gap-1.5">
          <Label>Priority</Label>
          <div role="radiogroup" aria-label="Priority" className="inline-flex gap-1 rounded-control border border-border bg-surface-3 p-1">
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => {
              const theme = PRIORITY_THEME[p];
              const active = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPriority(p)}
                  className={
                    active
                      ? 'rounded-[6px] px-2.5 py-1 text-xs font-bold'
                      : 'rounded-[6px] px-2.5 py-1 text-xs font-bold opacity-70 hover:opacity-100'
                  }
                  style={active ? { background: theme.softBg, color: theme.softFg } : undefined}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-danger-foreground">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary">Create story</Button>
        </div>
      </form>
    </Dialog>
  );
}
