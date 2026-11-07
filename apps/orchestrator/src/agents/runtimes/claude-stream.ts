import type { RuntimeEvent } from './types.ts';

interface ToolInfo { name: string; parentId?: string }
export interface ClaudeStreamState {
  malformedFrames: number;
  resultSeen: boolean;
  tools: Map<string, ToolInfo>;
  subagents: Map<string, string>;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return { malformedFrames: 0, resultSeen: false, tools: new Map(), subagents: new Map() };
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function usage(frame: Record<string, unknown>): RuntimeEvent {
  const value = object(frame.usage) ?? {};
  return {
    kind: 'usage', inputTokens: number(value.input_tokens),
    cachedInputTokens: number(value.cached_input_tokens ?? value.cache_read_input_tokens),
    outputTokens: number(value.output_tokens), costUsd: number(frame.total_cost_usd ?? value.total_cost_usd),
  };
}

/** Pure stream normalization: no output is logged here. Ignore all partial deltas. */
export function decodeClaudeFrame(frame: unknown, state: ClaudeStreamState): RuntimeEvent[] {
  const malformed = (): RuntimeEvent[] => { state.malformedFrames++; return []; };
  try {
    const value = object(frame);
    if (!value || !nonempty(value.type)) return malformed();
    if (value.type === 'stream_event') return [];
    if (value.type === 'system' && value.subtype === 'init') {
      return nonempty(value.session_id) ? [{ kind: 'session', ref: value.session_id }] : malformed();
    }
    if (value.type === 'result') {
      if (state.resultSeen) return [];
      if (typeof value.is_error !== 'boolean' || (value.result !== undefined && typeof value.result !== 'string')) return malformed();
      state.resultSeen = true;
      return [usage(value), {
        kind: 'result', isError: value.is_error,
        ...(typeof value.result === 'string' ? { text: value.result } : {}),
        ...('structured_output' in value ? { structured: value.structured_output } : {}),
        ...(typeof value.subtype === 'string' ? { subtype: value.subtype } : {}),
      }];
    }
    if (value.type === 'command') return nonempty(value.id) ? [{ kind: 'command', id: value.id }] : malformed();
    if (value.type === 'usage') return [usage(value)];
    if (value.type === 'denied') {
      return nonempty(value.tool) && typeof value.reason === 'string'
        ? [{ kind: 'denied', tool: value.tool, reason: value.reason }] : malformed();
    }
    if (value.type === 'subagent') {
      if (!nonempty(value.id) || (value.phase !== 'start' && value.phase !== 'end') ||
          (value.ok !== undefined && typeof value.ok !== 'boolean')) return malformed();
      const name = nonempty(value.name) ? value.name : state.subagents.get(value.id);
      if (!name) return malformed();
      if (value.phase === 'start') state.subagents.set(value.id, name);
      else state.subagents.delete(value.id);
      return [{ kind: 'subagent', phase: value.phase, id: value.id, name,
        ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}) }];
    }
    if (value.type === 'assistant' || value.type === 'user') {
      const message = object(value.message);
      if (!message || !Array.isArray(message.content)) return malformed();
      const events: RuntimeEvent[] = [];
      const texts: string[] = [];
      const tools = new Map(state.tools);
      for (const raw of message.content) {
        const block = object(raw);
        if (!block || !nonempty(block.type)) return malformed();
        if (block.type === 'text') {
          if (typeof block.text !== 'string') return malformed();
          if (value.type === 'assistant') texts.push(block.text);
        } else if (block.type === 'tool_use') {
          if (value.type !== 'assistant' || !nonempty(block.id) || !nonempty(block.name)) return malformed();
          const parentId = nonempty(value.parent_tool_use_id) ? value.parent_tool_use_id : undefined;
          const info = { name: block.name, ...(parentId ? { parentId } : {}) };
          tools.set(block.id, info);
          events.push({ kind: 'tool-start', id: block.id, ...info });
          if (block.name.toLowerCase() === 'bash') events.push({ kind: 'command', id: block.id });
        } else if (block.type === 'tool_result') {
          if (!nonempty(block.tool_use_id) || (block.is_error !== undefined && typeof block.is_error !== 'boolean')) return malformed();
          const info = tools.get(block.tool_use_id);
          if (!info) return malformed();
          events.push({ kind: 'tool-end', id: block.tool_use_id, ...info, ok: block.is_error !== true });
          tools.delete(block.tool_use_id);
        }
      }
      state.tools = tools;
      if (texts.length) events.unshift({ kind: 'message', text: texts.join('') });
      return events;
    }
    return [{ kind: 'unknown', type: value.type }];
  } catch {
    return malformed();
  }
}
