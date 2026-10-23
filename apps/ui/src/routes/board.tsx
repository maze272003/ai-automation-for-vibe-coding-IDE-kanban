// apps/ui/src/routes/board.tsx
import type { ProjectDTO } from '@aik/contracts';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Board } from '../components/kanban/board.tsx';
import { CreateStoryDialog } from '../components/kanban/create-story-dialog.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { api } from '../lib/api.ts';
import { useStories, type StoryQuery } from '../lib/stories.ts';

/** Milliseconds between the last keystroke and the search request. */
const SEARCH_DEBOUNCE_MS = 200;

export function BoardPage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [query, setQuery] = useState<StoryQuery>({ q: '', label: '', sort: 'rank' });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [creating, setCreating] = useState(false);

  // Keep the input responsive while the board refetches at most five times a second.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(query.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query.q]);

  const { stories, error, refetch } = useStories(id, { ...query, q: debouncedSearch });

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  return (
    <div className="flex h-full flex-col">
      <TopBar data-testid="board-toolbar" title={project ? `${project.key} · ${project.name}` : 'Board'}>
        <Input
          aria-label="Search stories"
          placeholder="Search…"
          value={query.q}
          onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))}
          className="w-56"
        />
        <Input
          aria-label="Filter by label"
          placeholder="Label"
          value={query.label}
          onChange={(e) => setQuery((q) => ({ ...q, label: e.target.value }))}
          className="w-32"
        />
        <Select
          aria-label="Sort stories"
          value={query.sort}
          onChange={(e) => setQuery((q) => ({ ...q, sort: e.target.value as StoryQuery['sort'] }))}
          className="w-40"
        >
          <option value="rank">Board order</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
        </Select>
        <Button data-testid="new-story" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          + New story
        </Button>
      </TopBar>
      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {error}
        </p>
      )}
      <Board stories={stories} onChanged={refetch} />
      <CreateStoryDialog open={creating} projectId={id} onClose={() => setCreating(false)} onCreated={() => void refetch()} />
    </div>
  );
}
