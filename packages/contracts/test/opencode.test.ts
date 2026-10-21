import { describe, expect, test } from 'vitest';
import { chronologicalMessages, extractAssistantText, findSessionFailure, sessionIsActive } from '../src/opencode.ts';

describe('OpenCode message helpers', () => {
  test('orders messages by time.created when the server sent it', () => {
    const ordered = chronologicalMessages([
      { type: 'idle', time: { created: 300 } },
      { type: 'assistant', time: { created: 100 } },
      { type: 'user', time: { created: 200 } },
    ]);
    expect(ordered.map((m) => m.type)).toEqual(['assistant', 'user', 'idle']);
  });

  test('keeps the received order when no timestamps are present', () => {
    const ordered = chronologicalMessages([{ type: 'user' }, { type: 'assistant' }]);
    expect(ordered.map((m) => m.type)).toEqual(['user', 'assistant']);
  });

  test('reads the last assistant text from a newest-first message list', () => {
    // The shape the pinned server returns: newest first, the newest assistant message is a
    // tool call without text, the answer sits in an earlier message.
    const messages = [
      { type: 'idle', outcome: 'succeeded', time: { created: 5 } },
      { type: 'assistant', finish: 'stop', content: [{ type: 'reasoning' }, { type: 'text', text: 'The final answer.' }], time: { created: 4 } },
      { type: 'assistant', finish: 'tool-calls', content: [{ type: 'tool' }], time: { created: 3 } },
      { type: 'user', content: [{ type: 'text', text: 'do it' }], time: { created: 1 } },
    ];
    expect(extractAssistantText(messages)).toBe('The final answer.');
  });

  test('falls back to the latest assistant text when the last turn had no text', () => {
    const messages = [
      { type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'first answer' }], time: { created: 1 } },
      { type: 'assistant', finish: 'tool-calls', content: [{ type: 'tool' }], time: { created: 2 } },
    ];
    expect(extractAssistantText(messages)).toBe('first answer');
  });

  test('joins several text parts of one message', () => {
    const messages = [{ type: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
    expect(extractAssistantText(messages)).toBe('a\nb');
  });

  test('returns an empty string when no assistant message carries text', () => {
    const messages = [{ type: 'assistant', content: [{ type: 'tool' }] }, { type: 'user', content: [{ type: 'text', text: 'hi' }] }];
    expect(extractAssistantText(messages)).toBe('');
  });

  test('finds the terminal failure of a session', () => {
    expect(findSessionFailure([{ type: 'idle', outcome: 'failed', error: { message: 'provider exploded' } }])).toEqual({
      message: 'provider exploded',
    });
    expect(findSessionFailure([{ type: 'assistant', finish: 'error', error: { message: 'boom' } }])).toEqual({ message: 'boom' });
    expect(findSessionFailure([{ type: 'idle', outcome: 'succeeded' }])).toBeNull();
  });

  test('detects whether the active payload lists a session', () => {
    expect(sessionIsActive({ data: { ses_abc: { type: 'running' } } }, 'ses_abc')).toBe(true);
    expect(sessionIsActive({ data: { ses_abc: { type: 'running' } } }, 'ses_xyz')).toBe(false);
    expect(sessionIsActive(null, 'ses_abc')).toBe(false);
  });
});
