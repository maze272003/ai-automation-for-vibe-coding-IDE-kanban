// apps/orchestrator/test/run-activity.test.ts
import { describe, expect, test } from 'vitest';
import { createActivityDiffState, diffActivity } from '../src/agents/run-activity.ts';

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
