import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createClaudeStreamState, decodeClaudeFrame } from '../src/agents/runtimes/claude-stream.ts';

// These committed fixtures are synthetic protocol examples, not captured live CLI output.
const fixture = (name: string): unknown[] => fs.readFileSync(new URL(`./fixtures/agent-cli/claude-2.1.319/${name}.jsonl`, import.meta.url), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
const session = { kind: 'session', ref: '11111111-2222-4333-8444-555555555555' };
const usage = { kind: 'usage', inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, costUsd: 0.01 };
const emptyUsage = { kind: 'usage', inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null };

describe('Claude stream normalization', () => {
  test('replays the success fixture to an exact normalized sequence', () => {
    const state = createClaudeStreamState();
    expect(fixture('success').flatMap((frame) => decodeClaudeFrame(frame, state))).toEqual([
      session, { kind: 'message', text: 'Finished the requested change.' }, usage,
      { kind: 'result', text: 'Finished the requested change.', isError: false, subtype: 'success' },
    ]);
    expect(state.malformedFrames).toBe(0);
  });

  test('replays subagent fixtures and remembers the name for the end event', () => {
    const state = createClaudeStreamState();
    expect(fixture('subagents').flatMap((frame) => decodeClaudeFrame(frame, state))).toEqual([
      session, { kind: 'subagent', phase: 'start', id: 'sa1', name: 'scout' },
      { kind: 'subagent', phase: 'end', id: 'sa1', name: 'scout', ok: true }, usage,
      { kind: 'result', text: 'Subagent finished.', isError: false, subtype: 'success' },
    ]);
  });

  test('preserves structured output and suppresses duplicate finals per run only', () => {
    const state = createClaudeStreamState();
    const frame = { type: 'result', result: '', structured_output: { ok: true }, is_error: false, subtype: 'success' };
    const expected = [emptyUsage, { kind: 'result', text: '', structured: { ok: true }, isError: false, subtype: 'success' }];
    expect(decodeClaudeFrame(frame, state)).toEqual(expected);
    expect(decodeClaudeFrame(frame, state)).toEqual([]);
    expect(decodeClaudeFrame(frame, createClaudeStreamState())).toEqual(expected);
  });

  test('preserves final usage from the committed fixture', () => {
    const state = createClaudeStreamState();
    expect(fixture('usage-at-end').flatMap((frame) => decodeClaudeFrame(frame, state))).toEqual([
      session, { kind: 'message', text: 'Done with the task.' },
      { kind: 'usage', inputTokens: 120, cachedInputTokens: 100, outputTokens: 30, costUsd: 0.02 },
      { kind: 'result', text: 'Done with the task.', isError: false, subtype: 'success' },
    ]);
  });

  test('does not substitute zero for missing or invalid usage', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'result', is_error: false, usage: {
      input_tokens: 0, cached_input_tokens: -1, output_tokens: Infinity, total_cost_usd: NaN,
    } }, state)[0]).toEqual({ ...emptyUsage, inputTokens: 0 });
  });

  test('drops partial text deltas completely, preserving only complete text', () => {
    const state = createClaudeStreamState();
    for (const text of ['secret-', 'fragment']) {
      expect(decodeClaudeFrame({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }, state)).toEqual([]);
    }
    expect(decodeClaudeFrame({ type: 'assistant', message: { content: [{ type: 'text', text: 'complete text' }] } }, state))
      .toEqual([{ kind: 'message', text: 'complete text' }]);
    expect(state.malformedFrames).toBe(0);
  });

  test('joins multiple complete text blocks without separators', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'assistant', message: { content: [
      { type: 'text', text: 'a-' }, { type: 'text', text: 'b' },
    ] } }, state)).toEqual([{ kind: 'message', text: 'a-b' }]);
  });

  test('tracks interleaved tools and parent relationships without cross-run state', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'assistant', parent_tool_use_id: 'parent', message: { content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
      { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'npm test' } },
    ] } }, state)).toEqual([
      { kind: 'tool-start', id: 'read-1', name: 'Read', parentId: 'parent' },
      { kind: 'tool-start', id: 'bash-2', name: 'Bash', parentId: 'parent' },
      { kind: 'command', id: 'bash-2' },
    ]);
    expect(decodeClaudeFrame({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'bash-2', is_error: true },
      { type: 'tool_result', tool_use_id: 'read-1', content: 'ok' },
    ] } }, state)).toEqual([
      { kind: 'tool-end', id: 'bash-2', name: 'Bash', ok: false, parentId: 'parent' },
      { kind: 'tool-end', id: 'read-1', name: 'Read', ok: true, parentId: 'parent' },
    ]);
  });

  test('malformed frames are counted and unknown types never expose raw payloads', () => {
    const state = createClaudeStreamState();
    const malformed = [null, [], 'raw secret', {}, { type: 42 }, { type: 'assistant', message: null }, { type: 'system', subtype: 'init' }];
    for (const frame of malformed) expect(decodeClaudeFrame(frame, state)).toEqual([]);
    expect(state.malformedFrames).toBe(malformed.length);
    expect(decodeClaudeFrame({ type: 'future_event', payload: 'raw secret' }, state)).toEqual([{ kind: 'unknown', type: 'future_event' }]);
    expect(state.malformedFrames).toBe(malformed.length);
  });

  test('replays the many-commands fixture to an exact normalized sequence', () => {
    const state = createClaudeStreamState();
    expect(fixture('many-commands').flatMap((frame) => decodeClaudeFrame(frame, state))).toEqual([
      session, { kind: 'command', id: 'c1' }, { kind: 'command', id: 'c2' }, { kind: 'command', id: 'c3' }, { kind: 'command', id: 'c4' },
      { kind: 'command', id: 'c5' }, { kind: 'command', id: 'c6' }, { kind: 'command', id: 'c7' }, { kind: 'command', id: 'c8' }, usage,
      { kind: 'result', text: 'Ran 8 commands.', isError: false, subtype: 'success' },
    ]);
    expect(state.malformedFrames).toBe(0);
  });

  test('denied frames require both tool and reason', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'denied', tool: 'Bash', reason: 'user denied' }, state))
      .toEqual([{ kind: 'denied', tool: 'Bash', reason: 'user denied' }]);
    expect(decodeClaudeFrame({ type: 'denied', reason: 'x' }, state)).toEqual([]);
    expect(decodeClaudeFrame({ type: 'denied', tool: 'Bash' }, state)).toEqual([]);
    expect(state.malformedFrames).toBe(2);
  });

  test('emits a standalone usage event for top-level usage frames', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }, state))
      .toEqual([{ kind: 'usage', inputTokens: 1, cachedInputTokens: null, outputTokens: 2, costUsd: null }]);
  });

  test('rejects result frames with missing or non-boolean is_error and subagent ends without a remembered start', () => {
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'result', result: 'x', subtype: 'success' }, state)).toEqual([]);
    expect(decodeClaudeFrame({ type: 'result', result: 'x', is_error: 'no', subtype: 'success' }, state)).toEqual([]);
    expect(decodeClaudeFrame({ type: 'subagent', phase: 'end', id: 'ghost' }, state)).toEqual([]);
    expect(state.malformedFrames).toBe(3);
  });

  test('counts parseable-but-invalid frames as malformed, leaving unparseable lines to the caller', () => {
    // fixture('malformed') contains a raw non-JSON line its JSON.parse-per-line loader cannot replay;
    // the stream caller skips such lines before decode, so only parseable garbage reaches this counter.
    const state = createClaudeStreamState();
    expect(decodeClaudeFrame({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } }, state)).toEqual([]);
    expect(state.malformedFrames).toBe(1);
  });
});
