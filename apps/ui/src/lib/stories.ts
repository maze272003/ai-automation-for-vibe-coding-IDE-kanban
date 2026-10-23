// apps/ui/src/lib/stories.ts
import type { StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from './api.ts';
import { useOutboxEvents, useSystemState } from './events.ts';

export interface StoryQuery {
  q: string;
  label: string;
  sort: 'rank' | 'priority' | 'updated' | 'created';
}

export function useStories(projectId: number, query: StoryQuery) {
  const [stories, setStories] = useState<StoryDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  // True until the first fetch settles, so the board can show skeleton cards
  // instead of flashing ten empty columns.
  const [loading, setLoading] = useState(true);
  const qs = new URLSearchParams({ sort: query.sort, ...(query.q ? { q: query.q } : {}), ...(query.label ? { label: query.label } : {}) }).toString();

  const refetch = useCallback(async () => {
    try {
      setStories(await api.get<StoryDTO[]>(`/projects/${projectId}/stories?${qs}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.reason : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, qs]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOutboxEvents((e) => {
    if (!e.topic.startsWith('story.') && e.topic !== 'system.resync') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refetch(), 100);
  });

  // After an orchestrator restart, our statusVersions may be stale: refetch (Review Focus #5).
  const system = useSystemState();
  useEffect(() => {
    if (system.state === 'ready') void refetch();
  }, [system.state, refetch]);

  return { stories, error, refetch, loading };
}
