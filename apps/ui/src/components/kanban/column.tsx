// apps/ui/src/components/kanban/column.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { STATUS_THEME } from '../../lib/status-theme.ts';
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
  onOpenTerminal?: (story: StoryDTO) => void;
}) {
  const { status, stories, collapsed, collapsible, highlight, onToggle, onDropStory, onMove, onOpenTerminal } = props;
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  const theme = STATUS_THEME[status];

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
      data-status={status}
      className={cn(
        'flex w-[246px] shrink-0 flex-col overflow-hidden rounded-panel border bg-surface backdrop-blur-[10px]',
        'shadow-[0_1px_0_rgb(255_255_255/0.05)_inset]',
        over
          ? 'border-accent/75 shadow-[0_0_0_1px_var(--accent),0_0_34px_-6px_var(--accent)]'
          : highlight
            ? 'border-accent/40'
            : 'border-glass-border',
      )}
    >
      <div
        data-testid={`column-rail-${status}`}
        aria-hidden="true"
        className="h-[3px] shrink-0"
        style={{ background: theme.rail }}
      />
      <header className="mb-2 flex items-center gap-2 px-3 pt-2.5">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: theme.dot }} />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted">{theme.label}</h2>
        <span
          className="ml-auto rounded-full border border-glass-border bg-surface-3 px-1.5 text-[11px] font-bold text-muted-2"
          style={stories.length > 0 ? { background: theme.softBg, color: theme.softFg, borderColor: 'transparent' } : undefined}
        >
          {stories.length}
        </span>
        {collapsible && (
          <button
            type="button"
            className="rounded-[6px] px-1 text-[11px] text-muted-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </header>
      {!collapsed && (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {stories.length === 0 && (
            <li
              data-testid={`column-empty-${status}`}
              className="rounded-card border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-2"
            >
              Nothing here yet
            </li>
          )}
          {stories.map((s) => (
            <li key={s.id}>
              <Card story={s} onMove={onMove} onOpenTerminal={onOpenTerminal} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
