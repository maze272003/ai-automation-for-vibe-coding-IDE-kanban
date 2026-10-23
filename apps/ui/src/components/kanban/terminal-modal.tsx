// apps/ui/src/components/kanban/terminal-modal.tsx
import { ACTIVE_STATUSES, type PlanV1, type StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { STATUS_THEME } from '../../lib/status-theme.ts';
import { answerClarifications, performEvent, rejectPlan, type ClarificationAnswer } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { ClarificationAnswersForm, RejectPlanDialog, type ClarificationQuestion } from './clarifications-dialog.tsx';
import { PullRequestCard } from '../github/pull-request-card.tsx';

interface OpenCodeMessageContent {
  type?: 'reasoning' | 'tool' | 'text' | string;
  text?: string;
  name?: string;
  id?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  time?: {
    created?: number;
    completed?: number;
  };
}

interface OpenCodeMessageItem {
  id?: string;
  type?: string;
  role?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: OpenCodeMessageContent[];
  time?: { created?: number; completed?: number };
}

interface AgentRunResponse {
  run: {
    id: number;
    role: string;
    status: string;
    model: string;
    opencodeSessionId: string | null;
    startedAt: number;
    endedAt: number | null;
    exitReason: string | null;
  } | null;
  messages: OpenCodeMessageItem[];
}

interface StoryDetailsResponse {
  plan: PlanV1 | null;
  verification: {
    status: string;
    commitSha: string;
    checks: {
      key: string;
      mandatory: boolean;
      command: string;
      status: string;
      exitCode: number | null;
      outputTail: string | null;
    }[];
  } | null;
  review: {
    verdict: string;
    rawVerdict: string;
    summary: string;
    normalizationNote: string | null;
    findings: {
      id: string;
      severity: string;
      category: string;
      file: string | null;
      explanation: string;
      recommendation: string;
      blocking: boolean;
      unverifiedLocation: boolean;
    }[];
    acResults: {
      criterionId: number;
      text: string;
      status: string;
      evidence: string;
    }[];
  } | null;
  diff: string | null;
}

export function TerminalModal({
  story,
  onClose,
  onChanged,
}: {
  story: StoryDTO;
  onClose: () => void;
  onChanged?: () => Promise<void>;
}) {
  const toast = useToast();
  const [data, setData] = useState<AgentRunResponse | null>(null);
  const [details, setDetails] = useState<StoryDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeMode, setActiveMode] = useState<'terminal' | 'plan' | 'verification' | 'review' | 'diff' | 'github'>(
    story.status === 'AWAITING_MERGE' ? 'diff' : story.status === 'TESTING' || (story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed') ? 'verification' : 'terminal',
  );
  const [activeTerminalTab, setActiveTerminalTab] = useState<'all' | 'reasoning' | 'tools' | 'output'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  const fetchRun = useCallback(async () => {
    try {
      const res = await window.api.request('GET', `/stories/${story.id}/agent-run`);
      if (res.status === 200 && res.body) {
        setData(res.body as AgentRunResponse);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [story.id]);

  const fetchDetails = useCallback(async () => {
    try {
      const res = await window.api.request('GET', `/stories/${story.id}/details`);
      if (res.status === 200 && res.body) {
        setDetails(res.body as StoryDetailsResponse);
      }
    } catch {
      // ignore
    }
  }, [story.id]);

  useEffect(() => {
    void fetchRun();
    void fetchDetails();
    const interval = setInterval(() => {
      void fetchRun();
      void fetchDetails();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchRun, fetchDetails]);

  // Elapsed timer
  useEffect(() => {
    const started = data?.run?.startedAt || story.activeRun?.startedAt;
    if (!started) return;
    const updateElapsed = () => {
      const end = data?.run?.endedAt ?? Date.now();
      const secs = Math.max(0, Math.floor((end - started) / 1000));
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      setElapsed(`${m}:${s.toString().padStart(2, '0')}`);
    };
    updateElapsed();
    const t = setInterval(updateElapsed, 1000);
    return () => clearInterval(t);
  }, [data?.run?.startedAt, data?.run?.endedAt, story.activeRun?.startedAt]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (activeMode === 'terminal' && autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [data?.messages, autoScroll, activeMode]);

  // Handle escape key (but not while the nested reject-plan dialog is open — that dialog owns Esc)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !rejectOpen) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, rejectOpen]);

  const sessionId = data?.run?.opencodeSessionId;
  const isRunning = story.status === 'IN_PROGRESS' || story.planningStatus === 'planning' || data?.run?.status === 'running';
  const statusTheme = STATUS_THEME[story.status];

  const handleCopyCommand = async () => {
    if (!sessionId) return;
    const cmd = `opencode --session ${sessionId}`;
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
    toast('Command copied to clipboard!', 'info');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenTerminal = async () => {
    if (!sessionId) return;
    try {
      await window.api.request('POST', '/api/desktop/open-terminal', {
        command: `opencode --session ${sessionId}`,
      });
      toast('Opened session in external terminal', 'info');
    } catch {
      await handleCopyCommand();
    }
  };

  const handleApproveMerge = async () => {
    if (!story.candidateSha) return;
    setMerging(true);
    try {
      await api.post(`/stories/${story.id}/transitions`, {
        event: 'approve_merge',
        sha: story.candidateSha,
        expectedVersion: story.statusVersion,
      });
      toast('Merge approved and queued for execution!', 'info');
      await onChanged?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.code === 'VERSION_CONFLICT') {
          // The modal's story snapshot is stale; refresh the board so the next attempt
          // uses the current statusVersion instead of failing identically forever.
          await onChanged?.();
          toast('The story changed; the board was refreshed', 'error');
        } else {
          toast(err.reason, 'error');
        }
      } else {
        toast(String(err), 'error');
      }
    } finally {
      setMerging(false);
    }
  };

  const handleRevertMerge = async () => {
    setReverting(true);
    try {
      const res = await api.post(`/stories/${story.id}/revert-merge`, {
        expectedVersion: story.statusVersion,
      });
      const data = res as { ok: boolean; revertSha: string };
      toast(`Merge reverted in commit ${data.revertSha.slice(0, 7)}! Base branch restored.`, 'info');
      await onChanged?.();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.code === 'VERSION_CONFLICT') {
          await onChanged?.();
          toast('The story changed; the board was refreshed', 'error');
        } else {
          toast(err.reason, 'error');
        }
      } else {
        toast(String(err), 'error');
      }
    } finally {
      setReverting(false);
    }
  };

  const handleStopRun = async () => {
    setStopping(true);
    try {
      const result = await performEvent(story, 'stop_run');
      if (!result.ok) {
        toast(result.reason, 'error');
        return;
      }
      toast('Stop requested; the active run is being interrupted', 'info');
      await onChanged?.();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setStopping(false);
    }
  };

  // Plan feedback (spec D-4): the proposed plan can be rejected with feedback, and a plan that
  // asked questions needs every open ordinal answered in one request before the re-plan runs.
  const planProposed = story.planningStatus === 'plan_proposed' && story.activePlanVersion !== null;
  const needsClarification = story.planningStatus === 'needs_clarification';
  // No endpoint exposes the clarifications rows; the open questions are the proposed plan's
  // clarificationQuestions (1-based ordinals), all open while the story is needs_clarification.
  const openQuestions: ClarificationQuestion[] =
    needsClarification && details?.plan
      ? details.plan.clarificationQuestions.map((question, i) => ({ ordinal: i + 1, question }))
      : [];

  const handleRejectPlan = async (feedback: string | null) => {
    setRejectOpen(false);
    if (feedback === null) return;
    setRejecting(true);
    try {
      const result = await rejectPlan(story, feedback);
      if (!result.ok) {
        toast(result.reason, 'error');
        return;
      }
      toast('Plan rejected; the planner will produce a new version', 'info');
      await onChanged?.();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setRejecting(false);
    }
  };

  const handleAnswerClarifications = async (answers: ClarificationAnswer[]) => {
    setAnswering(true);
    try {
      const result = await answerClarifications(story, answers);
      if (!result.ok) {
        toast(result.reason, 'error');
        return;
      }
      toast('Answers sent; the planner will re-plan with them', 'info');
      await onChanged?.();
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setAnswering(false);
    }
  };

  // Flatten events for terminal display
  const allEvents: Array<{
    key: string;
    type: 'reasoning' | 'tool' | 'text' | 'user';
    content: OpenCodeMessageContent;
    role?: string;
  }> = [];

  for (const [msgIdx, msg] of (data?.messages ?? []).entries()) {
    if (msg.role === 'user') {
      const text = msg.content?.map((c) => c.text).filter(Boolean).join('\n') || '';
      if (text) {
        allEvents.push({
          key: `user-${msgIdx}`,
          type: 'user',
          content: { type: 'text', text },
          role: 'user',
        });
      }
    } else {
      for (const [cIdx, c] of (msg.content ?? []).entries()) {
        const cType = c.type === 'reasoning' ? 'reasoning' : c.type === 'tool' ? 'tool' : 'text';
        allEvents.push({
          key: `asst-${msgIdx}-${cIdx}`,
          type: cType,
          content: c,
          role: 'assistant',
        });
      }
    }
  }

  const filteredEvents = allEvents.filter((e) => {
    if (activeTerminalTab === 'all') return true;
    if (activeTerminalTab === 'reasoning') return e.type === 'reasoning';
    if (activeTerminalTab === 'tools') return e.type === 'tool';
    if (activeTerminalTab === 'output') return e.type === 'text' || e.type === 'user';
    return true;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-story-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(4_7_16/0.70)] p-4 backdrop-blur-[3px]"
    >
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-panel border border-glass-border bg-[rgb(16_20_36/0.90)] shadow-panel backdrop-blur-[22px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface/40 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="rounded-[6px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-xs font-semibold text-muted">
                {story.key}
              </span>
              <span
                className="rounded-[6px] border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
                style={{
                  background: statusTheme.softBg,
                  color: statusTheme.softFg,
                  borderColor: 'transparent',
                }}
              >
                {story.status}
              </span>
            </div>

            <h2 id="modal-story-title" className="max-w-md truncate text-sm font-semibold text-foreground">
              {story.title}
            </h2>

            {elapsed && (
              <span className="rounded-[6px] border border-border bg-surface-3 px-2 py-0.5 font-mono text-xs text-muted-2">
                {elapsed}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {(ACTIVE_STATUSES as readonly string[]).includes(story.status) && (
              <button
                type="button"
                data-testid={`modal-stop-run-${story.key}`}
                onClick={handleStopRun}
                disabled={stopping}
                title="Interrupt the active run (the story becomes BLOCKED: interrupted)"
                className="flex cursor-pointer items-center gap-1.5 rounded border border-danger/40 bg-danger/15 px-3 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50"
              >
                <span aria-hidden="true">■</span>
                <span>{stopping ? 'Stopping…' : 'Stop run'}</span>
              </button>
            )}

            {story.status === 'AWAITING_MERGE' && (
              <button
                type="button"
                onClick={handleApproveMerge}
                disabled={merging || !story.candidateSha}
                className="flex cursor-pointer items-center gap-1.5 rounded border border-success/40 bg-success/15 px-3 py-1.5 text-xs font-bold text-success-foreground transition-colors hover:bg-success/25 disabled:opacity-50"
              >
                <span>✓</span>
                <span>{merging ? 'Merging...' : 'Approve & Merge'}</span>
              </button>
            )}

            {story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed' && (
              <button
                type="button"
                data-testid={`modal-revert-merge-${story.key}`}
                onClick={handleRevertMerge}
                disabled={reverting}
                title="Create a revert commit on the base branch to undo this failed merge"
                className="flex cursor-pointer items-center gap-1.5 rounded border border-danger/40 bg-danger/15 px-3 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50"
              >
                <span>↺</span>
                <span>{reverting ? 'Reverting…' : 'Revert Merge'}</span>
              </button>
            )}

            {sessionId && (
              <>
                <button
                  type="button"
                  onClick={handleOpenTerminal}
                  className="hidden items-center gap-1.5 rounded border border-teal-400/30 bg-teal-400/10 px-2.5 py-1.5 font-mono text-xs text-teal-300 transition-colors hover:bg-teal-400/20 sm:flex"
                  title="Open live session in external terminal"
                >
                  <span>Open in CLI</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="flex items-center gap-1.5 rounded border border-border bg-surface-3 px-2 py-1 font-mono text-xs text-muted transition-colors hover:text-foreground"
                >
                  <span>{copied ? 'Copied' : 'Copy CLI'}</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              className="rounded p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed' && (
          <div className="flex items-center justify-between border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger-foreground">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-semibold text-danger-foreground">⚠ Post-Merge Checks Failed:</span>
              <span className="truncate">{story.blocked.detail || 'Checks failed on the merged commit.'}</span>
            </div>
            <button
              type="button"
              data-testid={`banner-revert-merge-${story.key}`}
              onClick={handleRevertMerge}
              disabled={reverting}
              className="ml-3 shrink-0 cursor-pointer rounded border border-danger/40 bg-danger/15 px-2.5 py-1 text-[11px] font-medium text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50"
            >
              {reverting ? 'Reverting…' : 'Revert Merge Commit'}
            </button>
          </div>
        )}

        {/* Top-Level Mode Navigation */}
        <div className="flex items-center border-b border-border bg-surface/20 px-4">
          <button
            type="button"
            onClick={() => setActiveMode('terminal')}
            className={
              activeMode === 'terminal'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            Terminal Logs & Thoughts {allEvents.length > 0 && `(${allEvents.length})`}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('plan')}
            className={
              activeMode === 'plan'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            Architecture Plan {details?.plan ? '✓' : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('verification')}
            className={
              activeMode === 'verification'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            Verification Checks {details?.verification ? `(${details.verification.status})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('review')}
            className={
              activeMode === 'review'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            Code Review {details?.review ? `(${details.review.verdict})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('diff')}
            className={
              activeMode === 'diff'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            Git Changes (Diff) {details?.diff ? '✓' : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('github')}
            className={
              activeMode === 'github'
                ? 'border-b-2 border-accent px-3 py-2 text-xs font-bold text-foreground [box-shadow:0_6px_14px_-10px_var(--accent)]'
                : 'border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
            }
          >
            GitHub PR {story.pullRequest ? `(#${story.pullRequest.number})` : ''}
          </button>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 overflow-y-auto bg-surface-3 font-sans text-xs select-text">
          {/* 1. Terminal Mode */}
          {activeMode === 'terminal' && (
            <div className="flex flex-col h-full">
              {/* Filter pills */}
              <div className="flex items-center justify-between border-b border-border/60 bg-surface-3 px-4 py-2 text-xs">
                <div className="inline-flex gap-0.5 rounded-control border border-border bg-surface-3 p-0.5 font-mono">
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('all')}
                    className={
                      activeTerminalTab === 'all'
                        ? 'rounded-[6px] bg-accent/20 px-2.5 py-1 text-xs font-semibold text-accent-foreground'
                        : 'px-2.5 py-1 text-xs text-muted-2 transition-colors hover:text-foreground'
                    }
                  >
                    All ({allEvents.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('reasoning')}
                    className={
                      activeTerminalTab === 'reasoning'
                        ? 'rounded-[6px] bg-accent/20 px-2.5 py-1 text-xs font-semibold text-accent-foreground'
                        : 'px-2.5 py-1 text-xs text-muted-2 transition-colors hover:text-foreground'
                    }
                  >
                    Thoughts ({allEvents.filter((e) => e.type === 'reasoning').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('tools')}
                    className={
                      activeTerminalTab === 'tools'
                        ? 'rounded-[6px] bg-teal-400/15 px-2.5 py-1 text-xs font-semibold text-teal-300'
                        : 'px-2.5 py-1 text-xs text-muted-2 transition-colors hover:text-foreground'
                    }
                  >
                    Tools ({allEvents.filter((e) => e.type === 'tool').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('output')}
                    className={
                      activeTerminalTab === 'output'
                        ? 'rounded-[6px] bg-success/15 px-2.5 py-1 text-xs font-semibold text-success-foreground'
                        : 'px-2.5 py-1 text-xs text-muted-2 transition-colors hover:text-foreground'
                    }
                  >
                    Output
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setAutoScroll((v) => !v)}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                    autoScroll ? 'border-success/40 bg-success/10 text-success-foreground' : 'border-border text-muted-2'
                  }`}
                >
                  Auto-scroll {autoScroll ? 'ON' : 'OFF'}
                </button>
              </div>

              {/* Terminal log messages */}
              <div ref={logContainerRef} className="flex-1 space-y-3 overflow-y-auto p-4 font-mono">
                {loading && (
                  <div className="flex items-center justify-center py-12 text-muted-2">
                    <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-success border-t-transparent" />
                    Connecting to OpenCode agent runtime...
                  </div>
                )}
                {!loading && filteredEvents.length === 0 && (
                  <div className="rounded-card border border-dashed border-border p-8 text-center text-muted-2">
                    <p className="font-semibold text-muted">Agent session started</p>
                    <p className="mt-1 text-[11px]">
                      {isRunning ? 'Analyzing repository and preparing reasoning thoughts...' : 'No message logs recorded.'}
                    </p>
                  </div>
                )}
                {filteredEvents.map((ev) => {
                  const rail = ev.type === 'reasoning' ? '#a78bfa' : ev.type === 'tool' ? '#22d3ee' : ev.type === 'user' ? '#94a3b8' : '#34d399';
                  return (
                    <div key={ev.key} className="rounded-card border border-border bg-surface-3 p-3" style={{ borderLeft: `2px solid ${rail}` }}>
                      <div className="mb-1.5 flex items-center justify-between border-b border-border/60 pb-1.5 text-[11px] text-muted-2">
                        <span className="font-semibold uppercase tracking-wider" style={{ color: rail }}>
                          {ev.type}
                        </span>
                        {ev.content.time?.created && <span>{new Date(ev.content.time.created).toLocaleTimeString()}</span>}
                      </div>
                      <div className="whitespace-pre-wrap font-mono text-xs text-muted">
                        {ev.content.text || JSON.stringify(ev.content.state?.input ?? ev.content.state?.content ?? '', null, 2)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 2. Architecture Plan Mode */}
          {activeMode === 'plan' && (
            <div className="max-w-4xl space-y-6 p-6">
              {planProposed && (
                <div className="flex items-center justify-between gap-3 rounded-card border border-warning/30 bg-warning/10 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-warning-foreground">Plan v{story.activePlanVersion} proposed</h3>
                    <p className="mt-0.5 text-[11px] text-muted">
                      Approve it by dragging the card to Ready, or reject it — the planner re-plans with your feedback.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid={`modal-reject-plan-${story.key}`}
                    onClick={() => setRejectOpen(true)}
                    disabled={rejecting}
                    className="shrink-0 cursor-pointer rounded border border-danger/40 bg-danger/15 px-3 py-1.5 text-xs font-bold text-danger-foreground transition-colors hover:bg-danger/25 disabled:opacity-50"
                  >
                    {rejecting ? 'Rejecting…' : 'Reject plan…'}
                  </button>
                </div>
              )}

              {needsClarification && (
                <div className="space-y-3 rounded-card border border-warning/30 bg-warning/10 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-warning-foreground">Clarifications needed</h3>
                    <p className="mt-0.5 text-[11px] text-muted">
                      The planner cannot finish plan v{story.activePlanVersion ?? '—'} without these answers.
                    </p>
                  </div>
                  {openQuestions.length > 0 ? (
                    <ClarificationAnswersForm
                      questions={openQuestions}
                      busy={answering}
                      onSubmit={(answers) => void handleAnswerClarifications(answers)}
                    />
                  ) : (
                    <p className="text-xs text-muted-2">Waiting for the plan's questions to load…</p>
                  )}
                </div>
              )}

              {details?.plan ? (
                <>
                  <div className="space-y-2 rounded-card border border-border bg-surface-3 p-4">
                    <h3 className="text-sm font-semibold text-success">Technical Approach</h3>
                    <p className="leading-relaxed text-foreground">{details.plan.summary}</p>
                    <div className="flex items-center gap-2 pt-2">
                      <span className="rounded bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-foreground">
                        Complexity: {details.plan.complexity}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Subtasks & Steps</h3>
                    <div className="space-y-2">
                      {details.plan.subtasks.map((task) => (
                        <div key={task.id} className="flex items-start gap-3 rounded-card border border-border bg-surface-2 p-3">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-success/30 bg-success/10 font-mono text-[11px] text-success">
                            {task.id}
                          </span>
                          <div className="space-y-1">
                            <p className="font-medium text-foreground">{task.description}</p>
                            {task.files.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {task.files.map((f) => (
                                  <span key={f} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-muted-2">
                  <p>No architecture plan recorded for this story yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 3. Verification Mode */}
          {activeMode === 'verification' && (
            <div className="max-w-4xl space-y-6 p-6">
              {details?.verification ? (
                <>
                  <div className="flex items-center justify-between rounded-card border border-border bg-surface-3 p-4">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">Candidate Commit Verification</h3>
                      <p className="font-mono text-xs text-muted-2">SHA: {details.verification.commitSha}</p>
                    </div>
                    <span className={`rounded px-2.5 py-1 text-xs font-semibold uppercase ${
                      details.verification.status === 'passed' ? 'border border-success/30 bg-success/10 text-success-foreground' : 'border border-danger/30 bg-danger/10 text-danger-foreground'
                    }`}>
                      {details.verification.status}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Verification Checks</h3>
                    <div className="space-y-3">
                      {details.verification.checks.map((c) => (
                        <div key={c.key} className="space-y-2 rounded-card border border-border bg-surface-2 p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-foreground">{c.key}</span>
                              {c.mandatory && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">Mandatory</span>}
                            </div>
                            <span className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                              c.status === 'passed' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
                            }`}>
                              {c.status} (exit {c.exitCode ?? 0})
                            </span>
                          </div>
                          <code className="block rounded border border-border bg-black/50 p-2 font-mono text-xs text-muted">
                            {c.command}
                          </code>
                          {c.outputTail && (
                            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-foreground">
                              {c.outputTail}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-muted-2">
                  <p>Verification checks have not executed yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 4. Code Review Mode */}
          {activeMode === 'review' && (
            <div className="max-w-4xl space-y-6 p-6">
              {details?.review ? (
                <>
                  <div className="space-y-2 rounded-card border border-border bg-surface-3 p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">Review Decision</h3>
                      <span className={`rounded px-2.5 py-1 text-xs font-semibold uppercase ${
                        details.review.verdict === 'APPROVED' ? 'border border-success/30 bg-success/10 text-success-foreground' : 'border border-warning/30 bg-warning/10 text-warning-foreground'
                      }`}>
                        {details.review.verdict}
                      </span>
                    </div>
                    <p className="text-foreground">{details.review.summary}</p>
                    {details.review.normalizationNote && (
                      <p className="border-t border-border/80 pt-2 text-xs italic text-warning-foreground">
                        {details.review.normalizationNote}
                      </p>
                    )}
                  </div>

                  {details.review.findings.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Findings</h3>
                      <div className="space-y-2">
                        {details.review.findings.map((f) => (
                          <div key={f.id} className="space-y-1 rounded-card border border-border bg-surface-2 p-3">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-mono text-muted">
                                {f.id} · {f.category}
                                {f.file && <span className="text-muted-2"> · {f.file}</span>}
                              </span>
                              <span className="flex items-center gap-1.5">
                                {f.unverifiedLocation && (
                                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted" title="This file is neither in the diff nor in the repository">
                                    unverified location
                                  </span>
                                )}
                                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                                  f.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning-foreground'
                                }`}>
                                  {f.severity}
                                </span>
                              </span>
                            </div>
                            <p className="font-medium text-foreground">{f.explanation}</p>
                            <p className="text-xs text-muted">Recommendation: {f.recommendation}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {details.review.acResults.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Acceptance Criteria Verified</h3>
                      <div className="space-y-2">
                        {details.review.acResults.map((ac) => (
                          <div key={ac.criterionId} className="flex items-center justify-between rounded border border-border p-2.5">
                            <span className="text-foreground">{ac.text}</span>
                            <span className={`rounded px-2 py-0.5 font-mono text-[11px] ${
                              ac.status === 'met' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning-foreground'
                            }`}>
                              {ac.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="py-12 text-center text-muted-2">
                  <p>Independent code review has not run yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 5. Git Diff Mode */}
          {activeMode === 'diff' && (
            <div className="p-4">
              {details?.diff ? (
                <div className="overflow-x-auto rounded-card border border-border bg-surface-3 font-mono text-xs">
                  <div className="border-b border-border bg-surface-2 px-4 py-2 text-[11px] text-muted">
                    Git Candidate Diff · {story.candidateSha ? `Commit: ${story.candidateSha}` : ''}
                  </div>
                  <pre className="whitespace-pre p-4 font-mono leading-relaxed">
                    {details.diff.split('\n').map((line, idx) => {
                      const isAdd = line.startsWith('+') && !line.startsWith('+++');
                      const isDel = line.startsWith('-') && !line.startsWith('---');
                      const isHeader = line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@');

                      return (
                        <div
                          key={idx}
                          className={`${
                            isAdd ? 'bg-emerald-950/40 text-emerald-300' :
                            isDel ? 'bg-rose-950/40 text-rose-300' :
                            isHeader ? 'font-semibold text-teal-300' : 'text-muted'
                          } px-2 py-0.5`}
                        >
                          {line || ' '}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              ) : (
                <div className="py-12 text-center text-muted-2">
                  <p>No git diff available yet. A candidate commit must be captured first.</p>
                </div>
              )}
            </div>
          )}

          {/* 6. GitHub PR Mode */}
          {activeMode === 'github' && (
            <div className="mx-auto max-w-4xl p-4">
              <PullRequestCard story={story} onChanged={onChanged} />
            </div>
          )}
        </div>

        <RejectPlanDialog open={rejectOpen} onAnswer={(feedback) => void handleRejectPlan(feedback)} />
      </div>
    </div>
  );
}
