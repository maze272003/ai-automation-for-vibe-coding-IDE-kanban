// apps/ui/src/components/kanban/card.tsx
import { ACTIVE_STATUSES, isTerminal, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { BLOCKED_REASON_THEME, PRIORITY_THEME, STATUS_THEME } from '../../lib/status-theme.ts';
import { performEvent, type StoryActionEvent } from '../../lib/transitions.ts';
import { Badge } from '../ui/badge.tsx';
import { useToast } from '../ui/toast.tsx';
import { MoveMenu } from './move-menu.tsx';

function TerminalIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

export interface CardProps {
  story: StoryDTO;
  onMove: (story: StoryDTO, to: StoryStatus) => void;
  onOpenTerminal?: (story: StoryDTO) => void;
}

function CardImpl({ story, onMove, onOpenTerminal }: CardProps) {
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

  const priority = PRIORITY_THEME[story.priority];
  const status = STATUS_THEME[story.status];
  const blocked = story.blocked ? BLOCKED_REASON_THEME[story.blocked.reason] : null;

  return (
    <div
      ref={ref}
      data-testid={`card-${story.key}`}
      data-status={story.status}
      tabIndex={0}
      aria-label={`${story.key} ${story.title}`}
      className={cn(
        'relative rounded-card border p-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'content-visibility-auto',
        isWorking
          ? 'border-teal-400/35 bg-teal-400/[0.075]'
          : 'border-glass-border bg-surface-2 shadow-card',
      )}
    >
      {/* Hairline highlight along the top edge — the card never uses backdrop-filter. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2 top-0 h-px rounded-full bg-glass-highlight"
      />

      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-2">{story.key}</span>
        <span
          data-testid={`story-priority-${story.key}`}
          className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold leading-none"
          style={{ background: priority.softBg, color: priority.softFg }}
        >
          {priority.label}
        </span>
      </div>

      <p className="mt-1.5 text-sm font-medium leading-snug text-foreground">{story.title}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        {story.labels.map((l) => (
          <Badge key={l} tone="muted">{l}</Badge>
        ))}
        {story.hold && <Badge tone="warn">on hold</Badge>}
        {story.blocked && (
          <Badge
            tone="danger"
            title={story.blocked.hint}
            style={blocked ? { background: blocked.softBg, color: blocked.softFg } : undefined}
          >
            {`blocked: ${blocked?.label ?? story.blocked.reason}`}
          </Badge>
        )}
      </div>

      {isWorking && (
        <button
          type="button"
          data-testid={`active-run-${story.key}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[7px] border border-teal-400/30 bg-teal-400/10 px-2 py-1.5 font-mono text-[11px] text-teal-300 transition-colors hover:bg-teal-400/20"
          title={`Click to view OpenCode live CLI & agent thoughts for ${story.key}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-300 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-400" />
            </span>
            <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-teal-300" />
            <span className="truncate font-semibold">
              {activeModel ? `${activeModel}` : 'OpenCode'}
              {activeRole ? ` · ${activeRole}` : ''}
            </span>
          </span>
          <span className="shrink-0 animate-pulse text-[10px] uppercase tracking-wider text-teal-400">working</span>
        </button>
      )}

      {!isWorking && story.lastRun && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal?.(story);
          }}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-[7px] border border-border bg-surface-3 px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:text-foreground"
          title={`Inspect previous OpenCode run (${story.lastRun.status})`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <TerminalIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">
              CLI: {story.lastRun.model || 'OpenCode'} · {story.lastRun.role}
            </span>
          </span>
          <span className={cn('text-[10px] uppercase', story.lastRun.status === 'succeeded' ? 'text-success' : 'text-muted-2')}>
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
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[8px] border border-success/40 bg-success/15 px-2.5 py-1.5 text-xs font-bold text-success-foreground transition-colors hover:bg-success/25"
          title={`Review code changes and approve merge for ${story.key}`}
        >
          <span className="truncate">Review &amp; Merge</span>
          <span aria-hidden="true">→</span>
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
          className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-[8px] border border-danger/40 bg-danger/15 px-2.5 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25"
          title={`Post-merge verification failed for ${story.key}. Inspect failures and revert merge.`}
        >
          <span className="truncate">Revert Merge</span>
          <span aria-hidden="true">↺</span>
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
              className="rounded-[6px] border border-danger/35 bg-danger/10 px-2 py-1 text-xs font-semibold text-danger-foreground transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded-[6px] border border-warning/35 bg-warning/10 px-2 py-1 text-xs font-semibold text-warning-foreground transition-colors hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">{story.hold ? '▶' : '⏸'}</span>
              {story.hold ? 'Unhold' : 'Hold'}
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-2">
        <span data-testid={`story-attempts-${story.key}`}>
          attempt {story.attempts.used}/{story.attempts.max}
        </span>
        {story.candidateSha ? (
          <span className="truncate font-mono" title={`Candidate: ${story.candidateSha}`}>
            sha:{story.candidateSha.slice(0, 7)}
          </span>
        ) : story.branch ? (
          <span className="max-w-[120px] truncate font-mono" title={`Branch: ${story.branch}`}>
            {story.branch}
          </span>
        ) : null}
      </div>
      <MoveMenu story={story} onMove={onMove} />
      <span className="sr-only">{status.label}</span>
    </div>
  );
}

export const Card = memo(CardImpl);
