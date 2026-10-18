// apps/ui/src/components/kanban/card.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef } from 'react';
import { Badge } from '../ui/badge.tsx';
import { MoveMenu } from './move-menu.tsx';

export function Card({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ storyId: story.id }) });
  }, [story.id]);
  return (
    <div ref={ref} data-testid={`card-${story.key}`} tabIndex={0} aria-label={`${story.key} ${story.title}`} className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-zinc-500">{story.key}</span>
        <Badge>{story.priority}</Badge>
      </div>
      <p className="mt-1 text-sm font-medium">{story.title}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {story.labels.map((l) => <Badge key={l} tone="muted">{l}</Badge>)}
        {story.hold && <Badge tone="warn">on hold</Badge>}
        {story.blocked && <Badge tone="danger" title={story.blocked.hint}>blocked: {story.blocked.reason}</Badge>}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
        <span>attempt {story.attempts.used}/{story.attempts.max}</span>
        {story.activeRun && <span>{story.activeRun.model}</span>}
      </div>
      <MoveMenu story={story} onMove={onMove} />
    </div>
  );
}
