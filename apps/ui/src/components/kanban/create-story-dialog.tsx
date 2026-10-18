// apps/ui/src/components/kanban/create-story-dialog.tsx
import type { Priority } from '@aik/contracts';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
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
        <label className="flex flex-col gap-1 text-sm font-medium">
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
            {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary">Create story</Button>
        </div>
      </form>
    </Dialog>
  );
}
