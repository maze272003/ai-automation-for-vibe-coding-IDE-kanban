// apps/ui/src/components/kanban/column.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';
import { Card } from './card.tsx';

export function Column(props: {
  status: StoryStatus;
  stories: StoryDTO[];
  collapsed: boolean;
  collapsible: boolean;
  highlight: boolean;
  onToggle: () => void;
  onDropStory: (storyId: number, to: StoryStatus) => void;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
}) {
  const { status, stories, collapsed, collapsible, highlight, onToggle, onDropStory, onMove } = props;
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: () => ({ status }),
      canDrop: ({ source }) => typeof source.data.storyId === 'number',
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        onDropStory(source.data.storyId as number, status);
      },
    });
  }, [status, onDropStory]);
  return (
    <section
      ref={ref}
      aria-label={`${status} column`}
      data-testid={`column-${status}`}
      className={`flex w-72 shrink-0 flex-col rounded-lg border p-2 ${over ? 'border-indigo-500' : highlight ? 'border-indigo-300 dark:border-indigo-800' : 'border-zinc-200 dark:border-zinc-800'}`}
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wide">{status}</h2>
        <span className="text-xs text-zinc-500">{stories.length}</span>
        {collapsible && (
          <button type="button" className="ml-auto text-xs underline" aria-expanded={!collapsed} onClick={onToggle}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </header>
      {!collapsed && (
        <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto">
          {stories.map((s) => (
            <li key={s.id}>
              <Card story={s} onMove={onMove} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
