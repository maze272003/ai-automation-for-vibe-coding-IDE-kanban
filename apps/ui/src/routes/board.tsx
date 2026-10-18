// apps/ui/src/routes/board.tsx
import type { ProjectDTO } from '@aik/contracts';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Board } from '../components/kanban/board.tsx';
import { CreateStoryDialog } from '../components/kanban/create-story-dialog.tsx';
import { Button } from '../components/ui/button.tsx';
import { api } from '../lib/api.ts';
import { useStories, type StoryQuery } from '../lib/stories.ts';

export function BoardPage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [query, setQuery] = useState<StoryQuery>({ q: '', label: '', sort: 'rank' });
  const [creating, setCreating] = useState(false);
  const { stories, error, refetch } = useStories(id, query);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">{project ? `${project.key} · ${project.name}` : 'Board'}</h1>
        <input aria-label="Search stories" placeholder="Search…" value={query.q} onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        <input aria-label="Filter by label" placeholder="Label" value={query.label} onChange={(e) => setQuery((q) => ({ ...q, label: e.target.value }))} className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
        <select aria-label="Sort stories" value={query.sort} onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as StoryQuery['sort'] }))} className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950">
          <option value="rank">Board order</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
        </select>
        <Button data-testid="new-story" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>New story</Button>
      </div>
      {error && <p role="alert" className="px-4 py-2 text-sm text-red-600">{error}</p>}
      <Board stories={stories} onChanged={refetch} />
      <CreateStoryDialog open={creating} projectId={id} onClose={() => setCreating(false)} onCreated={() => void refetch()} />
    </div>
  );
}
