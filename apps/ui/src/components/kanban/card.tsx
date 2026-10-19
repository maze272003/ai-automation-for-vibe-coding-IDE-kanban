// apps/ui/src/components/kanban/card.tsx
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef } from 'react';
import { Badge } from '../ui/badge.tsx';
import { MoveMenu } from './move-menu.tsx';

function TerminalIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

export function Card({
  story,
  onMove,
  onOpenTerminal,
}: {
  story: StoryDTO;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
  onOpenTerminal?: (story: StoryDTO) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ storyId: story.id }) });
  }, [story.id]);

  const isWorking = Boolean(story.activeRun || story.planningStatus === 'planning');
  const activeModel = story.activeRun?.model;
  const activeRole = story.activeRun?.role ?? (story.planningStatus === 'planning' ? 'planner' : null);

  return (
    <div
      ref={ref}
      data-testid={`card-${story.key}`}
      tabIndex={0}
      aria-label={`${story.key} ${story.title}`}
      className={`rounded-md border p-3 shadow-sm transition-all focus-visible:outline-2 focus-visible:outline-indigo-500 ${
        isWorking
          ? 'border-emerald-500/70 bg-emerald-950/5 ring-1 ring-emerald-500/30 dark:border-emerald-500/50 dark:bg-emerald-950/20'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
      }`}
    >
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

      {isWorking && (
        <button
          type="button"
          data-testid={`active-run-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between rounded bg-zinc-950 px-2 py-1.5 font-mono text-xs text-emerald-400 shadow-inner border border-emerald-500/40 hover:border-emerald-400 hover:bg-zinc-900 transition-all cursor-pointer group dark:bg-black/80"
          title={`Click to view OpenCode live CLI & agent thoughts for ${story.key}`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <TerminalIcon className="h-3.5 w-3.5 text-emerald-400 shrink-0 group-hover:scale-110 transition-transform" />
            <span className="truncate text-[11px] font-semibold text-emerald-300">
              {activeModel ? `${activeModel}` : 'OpenCode'}
              {activeRole ? ` · ${activeRole}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="shrink-0 animate-pulse text-[10px] uppercase tracking-wider text-emerald-500/90">
              working
            </span>
            <span className="text-[10px] text-zinc-500 group-hover:text-emerald-400 transition-colors">↗</span>
          </div>
        </button>
      )}

      {!isWorking && story.lastRun && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2 flex w-full items-center justify-between rounded bg-zinc-900/40 px-2 py-1 font-mono text-[11px] text-zinc-400 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-200 transition-colors cursor-pointer group"
          title={`Inspect previous OpenCode run (${story.lastRun.status})`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <TerminalIcon className="h-3 w-3 text-zinc-500 group-hover:text-emerald-400 transition-colors shrink-0" />
            <span className="truncate">
              CLI: {story.lastRun.model || 'OpenCode'} · {story.lastRun.role}
            </span>
          </div>
          <span className={`text-[10px] uppercase ${story.lastRun.status === 'succeeded' ? 'text-emerald-500' : 'text-zinc-500'}`}>
            {story.lastRun.status}
          </span>
        </button>
      )}

      <div className="mt-2 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>attempt {story.attempts.used}/{story.attempts.max}</span>
        {story.candidateSha ? (
          <span className="font-mono text-[11px]" title={`Candidate: ${story.candidateSha}`}>
            sha:{story.candidateSha.slice(0, 7)}
          </span>
        ) : story.branch ? (
          <span className="font-mono text-[11px] truncate max-w-[120px]" title={`Branch: ${story.branch}`}>
            {story.branch}
          </span>
        ) : null}
      </div>
      <MoveMenu story={story} onMove={onMove} />
    </div>
  );
}
