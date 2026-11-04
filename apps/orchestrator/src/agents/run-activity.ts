// apps/orchestrator/src/agents/run-activity.ts — pure message→activity diffing for the
// office bubbles (spec 2026-11-04-office-agent-activity). Part shapes follow
// spikes/spk-1/out/probe-A-messages.json: tool parts are
// {type:'tool', id, name, state:{status, input}}; reasoning parts {type:'reasoning'}.
export interface RunActivityEvent {
  kind: 'tool-start' | 'tool-end';
  name: string;
  summary?: string;
}

export interface ActivityDiffState {
  /** Composite keys of parts already reported: `t:<id>` (started) and `e:<id>` (ended). */
  seen: Set<string>;
  thinking: boolean;
  /** Reasoning parts observed so far; only growth counts as *new* reasoning, since message snapshots repeat old parts every fetch. */
  reasoningSeen: number;
}

export function createActivityDiffState(): ActivityDiffState {
  return { seen: new Set(), thinking: false, reasoningSeen: 0 };
}

const basenameOf = (p: unknown): string | undefined =>
  typeof p === 'string' && p !== '' ? p.split(/[\\/]/).pop() : undefined;

// Summaries are returned in full: redaction and truncation happen downstream in
// appendRunActivity, so a secret straddling the 120-char cap is always redacted whole.
function summaryFor(name: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const inp = input as Record<string, unknown>;
  if (name === 'bash' && typeof inp.command === 'string' && inp.command !== '') return inp.command;
  return basenameOf(inp.path) ?? basenameOf(inp.file_path);
}

/**
 * Diff one message fetch against `state` (mutated). Event order within a tick:
 * Thinking-end first (a tool/text part followed the reasoning), then new tool starts,
 * then tool ends, then a Thinking-start if new reasoning appeared. Never throws.
 */
export function diffActivity(state: ActivityDiffState, messages: unknown[]): RunActivityEvent[] {
  const starts: RunActivityEvent[] = [];
  const ends: RunActivityEvent[] = [];
  let reasoningParts = 0;
  let sawText = false;
  try {
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as { type?: unknown; id?: unknown; name?: unknown; state?: unknown };
        if (p.type === 'reasoning') reasoningParts += 1;
        if (p.type === 'text') sawText = true;
        if (p.type !== 'tool' || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
        const raw = typeof p.state === 'object' && p.state !== null ? p.state : {};
        const st = raw as { status?: unknown; input?: unknown };
        const status = typeof st.status === 'string' ? st.status : 'running';
        const terminal = status === 'completed' || status === 'failed';
        if (!state.seen.has(`t:${p.id}`)) {
          state.seen.add(`t:${p.id}`);
          const summary = summaryFor(p.name, st.input);
          starts.push({ kind: 'tool-start', name: p.name, ...(summary !== undefined ? { summary } : {}) });
          if (terminal) {
            state.seen.add(`e:${p.id}`);
            ends.push({ kind: 'tool-end', name: p.name });
          }
        } else if (terminal && !state.seen.has(`e:${p.id}`)) {
          state.seen.add(`e:${p.id}`);
          ends.push({ kind: 'tool-end', name: p.name });
        }
      }
    }
  } catch {
    return []; // activity reporting must never break a run
  }
  const events: RunActivityEvent[] = [];
  if (state.thinking && (sawText || starts.length > 0)) {
    events.push({ kind: 'tool-end', name: 'Thinking' });
    state.thinking = false;
  }
  events.push(...starts, ...ends);
  const newReasoning = reasoningParts > state.reasoningSeen;
  if (newReasoning) state.reasoningSeen = reasoningParts;
  if (newReasoning && !state.thinking) {
    events.push({ kind: 'tool-start', name: 'Thinking' });
    state.thinking = true;
  }
  return events;
}
