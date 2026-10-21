// apps/ui/src/components/kanban/terminal-modal.tsx
import { ACTIVE_STATUSES, type PlanV1, type StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from '../../lib/api.ts';
import { answerClarifications, performEvent, rejectPlan, type ClarificationAnswer } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { ClarificationAnswersForm, RejectPlanDialog, type ClarificationQuestion } from './clarifications-dialog.tsx';

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
  const [activeMode, setActiveMode] = useState<'terminal' | 'plan' | 'verification' | 'review' | 'diff'>(
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
    >
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/90 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">
                {story.key}
              </span>
              <span className={`text-[11px] font-semibold uppercase px-2 py-0.5 rounded ${
                story.status === 'DONE' ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' :
                story.status === 'AWAITING_MERGE' ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40' :
                story.status === 'TESTING' ? 'bg-amber-950 text-amber-300 border border-amber-500/30' :
                'bg-zinc-800 text-zinc-300'
              }`}>
                {story.status}
              </span>
            </div>

            <h2 id="modal-story-title" className="truncate text-sm font-semibold text-zinc-100 max-w-md">
              {story.title}
            </h2>

            {elapsed && (
              <span className="font-mono text-xs text-zinc-500 bg-zinc-950/60 px-2 py-0.5 rounded border border-zinc-800">
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
                className="flex items-center gap-1.5 rounded bg-red-600 hover:bg-red-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-900/20 transition-all cursor-pointer disabled:opacity-50"
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
                className="flex items-center gap-1.5 rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-emerald-900/20 transition-all cursor-pointer disabled:opacity-50"
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
                className="flex items-center gap-1.5 rounded bg-red-600 hover:bg-red-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-900/20 transition-all cursor-pointer disabled:opacity-50"
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
                  className="hidden sm:flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-950/30 hover:bg-emerald-900/50 text-emerald-300 px-2.5 py-1.5 text-xs font-mono transition-colors"
                  title="Open live session in external terminal"
                >
                  <span>Open in CLI</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2 py-1 text-xs font-mono transition-colors"
                >
                  <span>{copied ? 'Copied' : 'Copy CLI'}</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {story.status === 'BLOCKED' && story.blocked?.reason === 'post_merge_failed' && (
          <div className="bg-red-950/60 border-b border-red-800/80 px-4 py-2 flex items-center justify-between text-xs text-red-200">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-red-300 shrink-0">⚠ Post-Merge Checks Failed:</span>
              <span className="truncate">{story.blocked.detail || 'Checks failed on the merged commit.'}</span>
            </div>
            <button
              type="button"
              data-testid={`banner-revert-merge-${story.key}`}
              onClick={handleRevertMerge}
              disabled={reverting}
              className="ml-3 shrink-0 px-2.5 py-1 rounded bg-red-700 hover:bg-red-600 text-white font-medium text-[11px] shadow transition-colors disabled:opacity-50 cursor-pointer"
            >
              {reverting ? 'Reverting…' : 'Revert Merge Commit'}
            </button>
          </div>
        )}

        {/* Top-Level Mode Navigation */}
        <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50 px-4">
          <button
            type="button"
            onClick={() => setActiveMode('terminal')}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeMode === 'terminal' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Terminal Logs & Thoughts {allEvents.length > 0 && `(${allEvents.length})`}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('plan')}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeMode === 'plan' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Architecture Plan {details?.plan ? '✓' : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('verification')}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeMode === 'verification' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Verification Checks {details?.verification ? `(${details.verification.status})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('review')}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeMode === 'review' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Code Review {details?.review ? `(${details.review.verdict})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveMode('diff')}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeMode === 'diff' ? 'border-emerald-500 text-emerald-400 font-semibold' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Git Changes (Diff) {details?.diff ? '✓' : ''}
          </button>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 overflow-y-auto bg-zinc-950 font-sans text-xs select-text">
          {/* 1. Terminal Mode */}
          {activeMode === 'terminal' && (
            <div className="flex flex-col h-full">
              {/* Filter pills */}
              <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/40 px-4 py-2 text-xs">
                <div className="flex rounded-lg bg-zinc-900 p-0.5 border border-zinc-800 font-mono">
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('all')}
                    className={`rounded px-2.5 py-1 text-xs transition-colors ${activeTerminalTab === 'all' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    All ({allEvents.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('reasoning')}
                    className={`rounded px-2.5 py-1 text-xs transition-colors ${activeTerminalTab === 'reasoning' ? 'bg-purple-900/60 text-purple-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Thoughts ({allEvents.filter((e) => e.type === 'reasoning').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('tools')}
                    className={`rounded px-2.5 py-1 text-xs transition-colors ${activeTerminalTab === 'tools' ? 'bg-cyan-900/60 text-cyan-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Tools ({allEvents.filter((e) => e.type === 'tool').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTerminalTab('output')}
                    className={`rounded px-2.5 py-1 text-xs transition-colors ${activeTerminalTab === 'output' ? 'bg-emerald-900/60 text-emerald-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Output
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setAutoScroll((v) => !v)}
                  className={`rounded px-2 py-1 text-[11px] font-mono border transition-colors ${
                    autoScroll ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300' : 'border-zinc-800 text-zinc-500'
                  }`}
                >
                  Auto-scroll {autoScroll ? 'ON' : 'OFF'}
                </button>
              </div>

              {/* Terminal log messages */}
              <div ref={logContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 font-mono">
                {loading && (
                  <div className="flex items-center justify-center py-12 text-zinc-500">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent mr-2" />
                    Connecting to OpenCode agent runtime...
                  </div>
                )}
                {!loading && filteredEvents.length === 0 && (
                  <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-zinc-500">
                    <p className="font-semibold text-zinc-400">Agent session started</p>
                    <p className="text-[11px] mt-1">
                      {isRunning ? 'Analyzing repository and preparing reasoning thoughts...' : 'No message logs recorded.'}
                    </p>
                  </div>
                )}
                {filteredEvents.map((ev) => (
                  <div key={ev.key} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
                    <div className="flex items-center justify-between border-b border-zinc-800/40 pb-1.5 mb-1.5 text-[11px] text-zinc-400">
                      <span className="font-semibold uppercase tracking-wider">{ev.type}</span>
                      {ev.content.time?.created && <span>{new Date(ev.content.time.created).toLocaleTimeString()}</span>}
                    </div>
                    <div className="whitespace-pre-wrap text-zinc-200 text-xs font-mono">
                      {ev.content.text || JSON.stringify(ev.content.state?.input ?? ev.content.state?.content ?? '', null, 2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 2. Architecture Plan Mode */}
          {activeMode === 'plan' && (
            <div className="p-6 space-y-6 max-w-4xl">
              {planProposed && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-amber-300">Plan v{story.activePlanVersion} proposed</h3>
                    <p className="mt-0.5 text-[11px] text-zinc-400">
                      Approve it by dragging the card to Ready, or reject it — the planner re-plans with your feedback.
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid={`modal-reject-plan-${story.key}`}
                    onClick={() => setRejectOpen(true)}
                    disabled={rejecting}
                    className="shrink-0 cursor-pointer rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-red-900/20 transition-all hover:bg-red-500 disabled:opacity-50"
                  >
                    {rejecting ? 'Rejecting…' : 'Reject plan…'}
                  </button>
                </div>
              )}

              {needsClarification && (
                <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-amber-300">Clarifications needed</h3>
                    <p className="mt-0.5 text-[11px] text-zinc-400">
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
                    <p className="text-xs text-zinc-500">Waiting for the plan's questions to load…</p>
                  )}
                </div>
              )}

              {details?.plan ? (
                <>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-emerald-400">Technical Approach</h3>
                    <p className="text-zinc-300 leading-relaxed">{details.plan.summary}</p>
                    <div className="pt-2 flex items-center gap-2">
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-300">
                        Complexity: {details.plan.complexity}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Subtasks & Steps</h3>
                    <div className="space-y-2">
                      {details.plan.subtasks.map((task) => (
                        <div key={task.id} className="rounded-lg border border-zinc-850 bg-zinc-900/30 p-3 flex items-start gap-3">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-emerald-950 text-emerald-400 font-mono text-[11px] border border-emerald-500/30">
                            {task.id}
                          </span>
                          <div className="space-y-1">
                            <p className="font-medium text-zinc-200">{task.description}</p>
                            {task.files.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {task.files.map((f) => (
                                  <span key={f} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
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
                <div className="text-center py-12 text-zinc-500">
                  <p>No architecture plan recorded for this story yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 3. Verification Mode */}
          {activeMode === 'verification' && (
            <div className="p-6 space-y-6 max-w-4xl">
              {details?.verification ? (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-200">Candidate Commit Verification</h3>
                      <p className="font-mono text-xs text-zinc-500">SHA: {details.verification.commitSha}</p>
                    </div>
                    <span className={`px-2.5 py-1 rounded text-xs font-semibold uppercase ${
                      details.verification.status === 'passed' ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-rose-950 text-rose-400 border border-rose-500/30'
                    }`}>
                      {details.verification.status}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Verification Checks</h3>
                    <div className="space-y-3">
                      {details.verification.checks.map((c) => (
                        <div key={c.key} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-zinc-300">{c.key}</span>
                              {c.mandatory && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Mandatory</span>}
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                              c.status === 'passed' ? 'text-emerald-400 bg-emerald-950' : 'text-rose-400 bg-rose-950'
                            }`}>
                              {c.status} (exit {c.exitCode ?? 0})
                            </span>
                          </div>
                          <code className="block rounded bg-black/60 p-2 font-mono text-xs text-zinc-400 border border-zinc-900">
                            {c.command}
                          </code>
                          {c.outputTail && (
                            <pre className="rounded bg-black/40 p-2 font-mono text-[11px] text-zinc-300 max-h-40 overflow-y-auto whitespace-pre-wrap">
                              {c.outputTail}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-12 text-zinc-500">
                  <p>Verification checks have not executed yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 4. Code Review Mode */}
          {activeMode === 'review' && (
            <div className="p-6 space-y-6 max-w-4xl">
              {details?.review ? (
                <>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-zinc-200">Review Decision</h3>
                      <span className={`px-2.5 py-1 rounded text-xs font-semibold uppercase ${
                        details.review.verdict === 'APPROVED' ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30' : 'bg-amber-950 text-amber-400 border border-amber-500/30'
                      }`}>
                        {details.review.verdict}
                      </span>
                    </div>
                    <p className="text-zinc-300">{details.review.summary}</p>
                    {details.review.normalizationNote && (
                      <p className="text-amber-400 text-xs italic border-t border-zinc-800/80 pt-2">
                        {details.review.normalizationNote}
                      </p>
                    )}
                  </div>

                  {details.review.findings.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Findings</h3>
                      <div className="space-y-2">
                        {details.review.findings.map((f) => (
                          <div key={f.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-mono text-zinc-400">
                                {f.id} · {f.category}
                                {f.file && <span className="text-zinc-500"> · {f.file}</span>}
                              </span>
                              <span className="flex items-center gap-1.5">
                                {f.unverifiedLocation && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold bg-zinc-800 text-zinc-400" title="This file is neither in the diff nor in the repository">
                                    unverified location
                                  </span>
                                )}
                                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                                  f.severity === 'critical' ? 'bg-rose-950 text-rose-400' : 'bg-amber-950 text-amber-400'
                                }`}>
                                  {f.severity}
                                </span>
                              </span>
                            </div>
                            <p className="text-zinc-200 font-medium">{f.explanation}</p>
                            <p className="text-zinc-400 text-xs">Recommendation: {f.recommendation}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {details.review.acResults.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Acceptance Criteria Verified</h3>
                      <div className="space-y-2">
                        {details.review.acResults.map((ac) => (
                          <div key={ac.criterionId} className="flex items-center justify-between rounded border border-zinc-850 p-2.5">
                            <span className="text-zinc-300">{ac.text}</span>
                            <span className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                              ac.status === 'met' ? 'text-emerald-400 bg-emerald-950' : 'text-amber-400 bg-amber-950'
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
                <div className="text-center py-12 text-zinc-500">
                  <p>Independent code review has not run yet.</p>
                </div>
              )}
            </div>
          )}

          {/* 5. Git Diff Mode */}
          {activeMode === 'diff' && (
            <div className="p-4">
              {details?.diff ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs overflow-x-auto">
                  <div className="bg-zinc-900/80 px-4 py-2 border-b border-zinc-800 text-zinc-400 text-[11px]">
                    Git Candidate Diff · {story.candidateSha ? `Commit: ${story.candidateSha}` : ''}
                  </div>
                  <pre className="p-4 leading-relaxed whitespace-pre font-mono">
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
                            isHeader ? 'text-cyan-400 font-semibold' : 'text-zinc-400'
                          } px-2 py-0.5`}
                        >
                          {line || ' '}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              ) : (
                <div className="text-center py-12 text-zinc-500">
                  <p>No git diff available yet. A candidate commit must be captured first.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <RejectPlanDialog open={rejectOpen} onAnswer={(feedback) => void handleRejectPlan(feedback)} />
      </div>
    </div>
  );
}
