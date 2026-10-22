// apps/ui/src/components/kanban/card.tsx
import { ACTIVE_STATUSES, isTerminal, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useEffect, useRef, useState } from 'react';
import { performEvent, type StoryActionEvent } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { Badge } from '../ui/badge.tsx';
import { MoveMenu } from './move-menu.tsx';

/** Shared chrome for the compact Stop/Hold controls (focus + disabled match Button's). */
const actionButtonClass =
  'flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

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
  const toast = useToast();
  const [busyAction, setBusyAction] = useState<StoryActionEvent | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({ element: el, getInitialData: () => ({ storyId: story.id }) });
  }, [story.id]);

  const isWorking = Boolean(story.activeRun || story.planningStatus === 'planning');
  const activeModel = story.activeRun?.model;
  const activeRole = story.activeRun?.role ?? (story.planningStatus === 'planning' ? 'planner' : null);

  // stop_run follows the machine's T13 guard (ACTIVE_STATUSES): verification runs with no
  // activeRun, and a stop must reach a running check tree (EXE-13); NEW never offers Stop.
  const canStopRun = (ACTIVE_STATUSES as readonly string[]).includes(story.status);
  const canToggleHold = !isTerminal(story.status);

  const runAction = async (event: StoryActionEvent, success: string) => {
    setBusyAction(event);
    try {
      const result = await performEvent(story, event);
      if (result.ok) toast(success, 'info');
      else toast(result.reason, 'error');
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusyAction(null);
    }
  };

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

      {story.pullRequest && (
        <a
          href={story.pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 flex items-center justify-between rounded bg-zinc-50 dark:bg-zinc-800/80 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors group"
        >
          <div className="flex items-center gap-1.5">
            <svg className="h-3.5 w-3.5 text-zinc-500 group-hover:text-indigo-400" fill="currentColor" viewBox="0 0 16 16">
              <path fillRule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
            </svg>
            <span className="font-semibold text-[11px]">PR #{story.pullRequest.number}</span>
          </div>
          <Badge tone={story.pullRequest.state === 'merged' ? 'ok' : story.pullRequest.state === 'closed' ? 'muted' : 'default'}>
            {story.pullRequest.state}
          </Badge>
        </a>
      )}

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

      {story.status === 'AWAITING_MERGE' && (
        <button
          type="button"
          data-testid={`awaiting-merge-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between rounded bg-emerald-600 hover:bg-emerald-500 px-2.5 py-1.5 font-medium text-xs text-white shadow transition-all cursor-pointer group"
          title={`Review code changes and approve merge for ${story.key}`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <svg className="h-3.5 w-3.5 shrink-0 text-emerald-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="truncate font-semibold text-[11px]">Review & Merge</span>
          </div>
          <span className="text-[10px] text-emerald-100 group-hover:translate-x-0.5 transition-transform">→</span>
        </button>
      )}

      {story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed' && (
        <button
          type="button"
          data-testid={`revert-merge-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between rounded bg-red-600 hover:bg-red-500 px-2.5 py-1.5 font-medium text-xs text-white shadow transition-all cursor-pointer group"
          title={`Post-merge verification failed for ${story.key}. Inspect failures and revert merge.`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <svg className="h-3.5 w-3.5 shrink-0 text-red-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="truncate font-semibold text-[11px]">Revert Merge</span>
          </div>
          <span className="text-[10px] text-red-100 group-hover:translate-x-0.5 transition-transform">→</span>
        </button>
      )}

      {(canStopRun || canToggleHold) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canStopRun && (
            <button
              type="button"
              data-testid={`stop-run-${story.key}`}
              onClick={(e) => {
                e.stopPropagation();
                void runAction('stop_run', `Stop requested for ${story.key}; the active run is being interrupted`);
              }}
              disabled={busyAction !== null}
              title={`Interrupt the active run and block ${story.key} as interrupted`}
              className={`${actionButtonClass} border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/60`}
            >
              <span aria-hidden="true">■</span>
              {busyAction === 'stop_run' ? 'Stopping…' : 'Stop run'}
            </button>
          )}
          {canToggleHold && (
            <button
              type="button"
              data-testid={`hold-toggle-${story.key}`}
              onClick={(e) => {
                e.stopPropagation();
                void runAction(
                  story.hold ? 'unhold' : 'hold',
                  story.hold ? `${story.key} taken off hold` : `${story.key} put on hold`,
                );
              }}
              disabled={busyAction !== null}
              title={story.hold ? `Let scheduled work resume for ${story.key}` : `Pause scheduled work for ${story.key} without changing its status`}
              className={`${actionButtonClass} border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/60`}
            >
              <span aria-hidden="true">{story.hold ? '▶' : '⏸'}</span>
              {story.hold ? 'Unhold' : 'Hold'}
            </button>
          )}
        </div>
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
