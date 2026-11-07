// apps/orchestrator/test/run-activity.test.ts
import { describe, expect, test } from 'vitest';
import { createActivityDiffState, diffActivity, toActivity } from '../src/agents/run-activity.ts';

/** Part shapes follow spikes/spk-1/out/probe-A-messages.json (tool state.input.path, bash command). */
const tool = (id: string, name: string, status: string, input: Record<string, unknown> = {}) => ({
  type: 'tool', id, name, state: { status, input },
});

describe('diffActivity', () => {
  test('a new completed tool emits start then end with a file summary', () => {
    const state = createActivityDiffState();
    const messages = [{ role: 'assistant', content: [tool('p1', 'edit', 'completed', { path: 'C:/x/src/foo.ts' })] }];
    expect(diffActivity(state, messages)).toEqual([
      { kind: 'tool-start', name: 'edit', summary: 'foo.ts' },
      { kind: 'tool-end', name: 'edit' },
    ]);
    // Second diff of the same messages: nothing new.
    expect(diffActivity(state, messages)).toEqual([]);
  });

  test('running tool starts now, ends on a later tick', () => {
    const state = createActivityDiffState();
    const first = [{ role: 'assistant', content: [tool('p1', 'bash', 'running', { command: 'npm test' })] }];
    expect(diffActivity(state, first)).toEqual([{ kind: 'tool-start', name: 'bash', summary: 'npm test' }]);
    const later = [{ role: 'assistant', content: [tool('p1', 'bash', 'completed', { command: 'npm test' })] }];
    expect(diffActivity(state, later)).toEqual([{ kind: 'tool-end', name: 'bash' }]);
  });

  test('bash commands pass through in full (redaction/truncation happen downstream); long paths use the basename', () => {
    const state = createActivityDiffState();
    const long = 'x'.repeat(200);
    const messages = [
      { role: 'assistant', content: [tool('p1', 'bash', 'running', { command: long })] },
    ];
    expect(diffActivity(state, messages)).toEqual([
      { kind: 'tool-start', name: 'bash', summary: long },
    ]);
  });

  test('reasoning starts Thinking; a following text part ends it before other events', () => {
    const state = createActivityDiffState();
    const tick1 = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] }];
    expect(diffActivity(state, tick1)).toEqual([{ kind: 'tool-start', name: 'Thinking' }]);
    const tick2 = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'hmm' }, tool('p1', 'read', 'running', { path: 'a/b.ts' })],
      },
    ];
    expect(diffActivity(state, tick2)).toEqual([
      { kind: 'tool-end', name: 'Thinking' },
      { kind: 'tool-start', name: 'read', summary: 'b.ts' },
    ]);
  });

  test('unknown shapes are ignored without throwing', () => {
    const state = createActivityDiffState();
    expect(diffActivity(state, [{ type: 'idle', outcome: 'succeeded' }, null, { content: 'nope' }, { content: [{}] }])).toEqual([]);
  });
});

describe('toActivity', () => {
  test('tool-start/tool-end keep only kind and name; id, parentId and ok are dropped', () => {
    expect(toActivity({ kind: 'tool-start', id: 't1', name: 'edit', parentId: 'p1' })).toEqual({ kind: 'tool-start', name: 'edit' });
    expect(toActivity({ kind: 'tool-end', id: 't1', name: 'edit', ok: true, parentId: 'p1' })).toEqual({ kind: 'tool-end', name: 'edit' });
  });

  test('message keeps its text; session/command/result/denied/unknown map to null', () => {
    expect(toActivity({ kind: 'message', text: 'hello' })).toEqual({ kind: 'message', text: 'hello' });
    expect(toActivity({ kind: 'session', ref: 'sess-1' })).toBeNull();
    expect(toActivity({ kind: 'command', id: 'c1' })).toBeNull();
    expect(toActivity({ kind: 'result', text: 'done', isError: false })).toBeNull();
    expect(toActivity({ kind: 'denied', tool: 'bash', reason: 'not allowed' })).toBeNull();
    expect(toActivity({ kind: 'unknown', type: 'stream' })).toBeNull();
  });

  test('subagent keeps phase/id/name; ok appears only when boolean', () => {
    expect(toActivity({ kind: 'subagent', phase: 'start', id: 'sa1', name: 'researcher' })).toEqual({ kind: 'subagent', phase: 'start', id: 'sa1', name: 'researcher' });
    expect(toActivity({ kind: 'subagent', phase: 'end', id: 'sa1', name: 'researcher', ok: true })).toEqual({ kind: 'subagent', phase: 'end', id: 'sa1', name: 'researcher', ok: true });
    expect(toActivity({ kind: 'subagent', phase: 'end', id: 'sa1', name: 'researcher', ok: false })).toEqual({ kind: 'subagent', phase: 'end', id: 'sa1', name: 'researcher', ok: false });
  });

  test('usage keeps every counter, preserving nulls as null', () => {
    expect(toActivity({ kind: 'usage', inputTokens: 1_200, cachedInputTokens: null, outputTokens: 300, costUsd: null })).toEqual({ kind: 'usage', inputTokens: 1_200, cachedInputTokens: null, outputTokens: 300, costUsd: null });
    expect(toActivity({ kind: 'usage', inputTokens: null, cachedInputTokens: 10, outputTokens: null, costUsd: 0.02 })).toEqual({ kind: 'usage', inputTokens: null, cachedInputTokens: 10, outputTokens: null, costUsd: 0.02 });
  });
});
