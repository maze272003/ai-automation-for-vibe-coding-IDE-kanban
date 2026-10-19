// apps/ui/src/components/kanban/terminal-modal.tsx
import type { StoryDTO } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../ui/toast.tsx';

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

export function TerminalModal({ story, onClose }: { story: StoryDTO; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<AgentRunResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'reasoning' | 'tools' | 'output'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
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

  useEffect(() => {
    void fetchRun();
    const interval = setInterval(() => {
      void fetchRun();
    }, 1500);
    return () => clearInterval(interval);
  }, [fetchRun]);

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
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [data?.messages, autoScroll]);

  // Handle escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sessionId = data?.run?.opencodeSessionId || story.activeRun?.opencodeSessionId;
  const modelName = data?.run?.model || story.activeRun?.model || 'OpenCode';
  const role = data?.run?.role || story.activeRun?.role || (story.planningStatus === 'planning' ? 'planner' : 'implementer');
  const isRunning = data?.run?.status === 'running' || story.activeRun !== null;

  const handleOpenTerminal = async () => {
    if (!sessionId) {
      toast('No active OpenCode session ID available yet.', 'error');
      return;
    }
    if (window.api.openTerminalCli) {
      const res = await window.api.openTerminalCli({ sessionId });
      if (res.ok) {
        toast(`Launched external terminal attached to session ${sessionId.slice(0, 12)}...`, 'info');
      } else {
        toast(`Failed to launch terminal: ${res.error ?? 'unknown error'}`, 'error');
      }
    } else {
      // Web mode fallback
      await navigator.clipboard.writeText(`opencode --session ${sessionId}`);
      toast(`Copied CLI attach command to clipboard: opencode --session ${sessionId}`, 'info');
    }
  };

  const handleCopyCommand = async () => {
    if (!sessionId) return;
    await navigator.clipboard.writeText(`opencode --session ${sessionId}`);
    setCopied(true);
    toast(`Copied: opencode --session ${sessionId}`, 'info');
    setTimeout(() => setCopied(false), 2000);
  };

  const messages = data?.messages ?? [];

  // Extract events for tabs
  const allEvents: { key: string; type: 'reasoning' | 'tool' | 'text' | 'user'; content: OpenCodeMessageContent; raw: OpenCodeMessageItem }[] = [];
  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const m = messages[mIdx];
    if (!m) continue;
    if (m.type === 'user') {
      const text = m.content?.[0]?.text ?? '';
      allEvents.push({
        key: `user-${mIdx}`,
        type: 'user',
        content: { type: 'text', text },
        raw: m,
      });
    } else if (m.content && Array.isArray(m.content)) {
      m.content.forEach((c, cIdx) => {
        if (c.type === 'reasoning' || c.type === 'tool' || c.type === 'text') {
          allEvents.push({
            key: `item-${mIdx}-${cIdx}`,
            type: c.type as 'reasoning' | 'tool' | 'text',
            content: c,
            raw: m,
          });
        }
      });
    }
  }

  const filteredEvents = allEvents.filter((ev) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'reasoning') return ev.type === 'reasoning';
    if (activeTab === 'tools') return ev.type === 'tool';
    if (activeTab === 'output') return ev.type === 'text';
    return true;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`OpenCode CLI Terminal - ${story.key}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="flex h-[88vh] max-h-[850px] w-full max-w-5xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl text-zinc-100 overflow-hidden font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/90 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 font-mono text-sm font-bold shadow-inner">
              &gt;_
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                  {story.key}
                </span>
                <h2 className="text-sm font-semibold truncate text-zinc-100">{story.title}</h2>
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5 font-mono">
                <span className="flex items-center gap-1.5">
                  {isRunning ? (
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                  ) : data?.run?.status === 'failed' ? (
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-zinc-500" />
                  )}
                  <span className={isRunning ? 'text-emerald-400 font-semibold' : data?.run?.status === 'failed' ? 'text-rose-400' : 'text-zinc-400'}>
                    {isRunning ? 'RUNNING' : data?.run?.status?.toUpperCase() ?? 'IDLE'}
                  </span>
                </span>
                <span>•</span>
                <span className="text-indigo-300 font-medium">{modelName}</span>
                <span>•</span>
                <span className="text-zinc-300 capitalize">{role}</span>
                {elapsed && (
                  <>
                    <span>•</span>
                    <span className="text-zinc-400">{elapsed}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {sessionId && (
              <>
                <button
                  type="button"
                  onClick={handleOpenTerminal}
                  className="flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium shadow-md transition-colors"
                  title="Open live session attached in your external terminal (cmd.exe / opencode)"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span>Open in Terminal CLI</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 px-2.5 py-1.5 text-xs font-mono transition-colors"
                  title="Copy command to attach in your own terminal"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>{copied ? 'Copied!' : 'Copy CLI'}</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close terminal modal"
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors ml-1"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Sub-header with Session details & Filters */}
        <div className="flex flex-wrap items-center justify-between border-b border-zinc-800/60 bg-zinc-900/40 px-4 py-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
            <span className="text-zinc-500">SESSION:</span>
            {sessionId ? (
              <span className="text-emerald-400 font-semibold select-all">{sessionId}</span>
            ) : (
              <span className="text-zinc-500 italic">initiating session...</span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <div className="flex rounded-lg bg-zinc-900 p-0.5 border border-zinc-800">
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'all' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All ({allEvents.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('reasoning')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'reasoning' ? 'bg-purple-900/60 text-purple-200 border border-purple-500/30' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Thoughts ({allEvents.filter((e) => e.type === 'reasoning').length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('tools')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'tools' ? 'bg-cyan-900/60 text-cyan-200 border border-cyan-500/30' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Tools ({allEvents.filter((e) => e.type === 'tool').length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('output')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'output' ? 'bg-emerald-900/60 text-emerald-200 border border-emerald-500/30' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Output
              </button>
            </div>

            <button
              type="button"
              onClick={() => setAutoScroll((v) => !v)}
              className={`ml-2 rounded px-2 py-1 text-[11px] font-mono border transition-colors ${
                autoScroll ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle automatic scrolling to bottom as new thoughts arrive"
            >
              Auto-scroll {autoScroll ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Terminal Content Body */}
        <div ref={logContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-zinc-950 font-mono text-xs select-text">
          {loading && (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              <div className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                <span>Connecting to OpenCode agent runtime...</span>
              </div>
            </div>
          )}

          {!loading && filteredEvents.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-zinc-500 space-y-2">
              <p className="font-semibold text-zinc-400">Agent session started</p>
              <p className="text-[11px]">
                {isRunning
                  ? 'Model is currently initializing repository analysis and formulating reasoning thoughts...'
                  : 'No message logs found for this run.'}
              </p>
              {sessionId && (
                <div className="pt-2">
                  <code className="rounded bg-zinc-900 px-2 py-1 text-emerald-400 text-[11px]">
                    opencode --session {sessionId}
                  </code>
                </div>
              )}
            </div>
          )}

          {filteredEvents.map((ev) => {
            if (ev.type === 'reasoning') {
              return (
                <div
                  key={ev.key}
                  className="rounded-lg border border-purple-500/20 bg-purple-950/10 p-3 shadow-sm hover:border-purple-500/40 transition-colors"
                >
                  <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-purple-500/10 text-[11px] text-purple-400">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <svg className="h-3.5 w-3.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span>Reasoning Thought</span>
                    </div>
                    {ev.content.time?.created && (
                      <span className="text-[10px] text-purple-400/60 font-mono">
                        {new Date(ev.content.time.created).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap text-zinc-200 leading-relaxed text-[11.5px] font-sans">
                    {ev.content.text}
                  </div>
                </div>
              );
            }

            if (ev.type === 'tool') {
              const status = ev.content.state?.status ?? 'completed';
              const input = ev.content.state?.input ?? {};
              const output = ev.content.state?.content?.map((c) => c.text).filter(Boolean).join('\n');

              return (
                <div
                  key={ev.key}
                  className="rounded-lg border border-cyan-500/25 bg-cyan-950/10 p-3 shadow-sm hover:border-cyan-500/40 transition-colors"
                >
                  <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-cyan-500/15 text-[11px]">
                    <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                      <svg className="h-3.5 w-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span>Tool Invocation:</span>
                      <span className="rounded bg-cyan-950 px-1.5 py-0.5 text-cyan-200 border border-cyan-500/40">
                        {ev.content.name || 'tool'}
                      </span>
                    </div>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${
                        status === 'completed'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/30'
                          : status === 'running'
                          ? 'bg-amber-950 text-amber-300 border border-amber-500/30 animate-pulse'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {status}
                    </span>
                  </div>

                  {/* Input parameters */}
                  {Object.keys(input).length > 0 && (
                    <div className="mb-2">
                      <div className="text-[10px] uppercase text-zinc-500 mb-1">Parameters:</div>
                      <pre className="rounded bg-zinc-900/80 p-2 text-cyan-200/90 text-[11px] overflow-x-auto border border-zinc-800/80">
                        {JSON.stringify(input, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Output preview */}
                  {output && (
                    <div>
                      <div className="text-[10px] uppercase text-zinc-500 mb-1">Output:</div>
                      <pre className="rounded bg-black/60 p-2 text-zinc-300 text-[11px] max-h-48 overflow-y-auto border border-zinc-900 whitespace-pre-wrap">
                        {output.length > 2000 ? `${output.slice(0, 2000)}\n... [truncated]` : output}
                      </pre>
                    </div>
                  )}
                </div>
              );
            }

            if (ev.type === 'user') {
              return (
                <div key={ev.key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 shadow-sm">
                  <div className="text-[11px] font-semibold text-zinc-400 mb-1 flex items-center gap-1.5">
                    <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    <span>User Task Prompt</span>
                  </div>
                  <div className="text-zinc-300 whitespace-pre-wrap text-[11px] max-h-36 overflow-y-auto">
                    {ev.content.text}
                  </div>
                </div>
              );
            }

            // Fallback for general text / response
            return (
              <div key={ev.key} className="rounded-lg border border-emerald-500/20 bg-emerald-950/10 p-3 shadow-sm">
                <div className="text-[11px] font-semibold text-emerald-400 mb-1 flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                  <span>Model Output</span>
                </div>
                <div className="text-zinc-100 whitespace-pre-wrap text-[11.5px] leading-relaxed">
                  {ev.content.text}
                </div>
              </div>
            );
          })}

          {isRunning && (
            <div className="flex items-center gap-2 pt-2 text-emerald-400/90 text-xs font-mono">
              <span className="inline-block h-2 w-2 animate-ping rounded-full bg-emerald-400" />
              <span>Streaming agent reasoning &amp; CLI execution live...</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800/80 bg-zinc-900/80 px-4 py-2.5 text-xs text-zinc-400">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span>Attach via CLI:</span>
            <code className="rounded bg-black/60 px-2 py-0.5 text-emerald-400 select-all border border-zinc-800">
              opencode {sessionId ? `--session ${sessionId}` : ''}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
