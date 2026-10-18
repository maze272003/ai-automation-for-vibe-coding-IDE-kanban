import { describe, expect, it } from 'vitest';
import { createSseParser, formatSse, type SseMessage } from '../src/index.ts';

function collect(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const feed = createSseParser((m) => out.push(m));
  for (const c of chunks) feed(c);
  return out;
}

describe('createSseParser', () => {
  it('parses a complete message', () => {
    expect(collect(['id: 7\ndata: {"a":1}\n\n'])).toEqual([{ id: '7', event: 'message', data: '{"a":1}' }]);
  });
  it('handles messages split across arbitrary chunk boundaries', () => {
    const text = 'id: 1\ndata: hello\n\nid: 2\ndata: world\n\n';
    const chunks = text.split('');
    expect(collect(chunks).map((m) => [m.id, m.data])).toEqual([['1', 'hello'], ['2', 'world']]);
  });
  it('ignores comments (heartbeats) and joins multi-line data', () => {
    expect(collect([': hb\n\ndata: a\ndata: b\n\n'])).toEqual([{ id: null, event: 'message', data: 'a\nb' }]);
  });
  it('does not dispatch early when a CRLF is split between chunks', () => {
    const out = collect(['data: x\r', '\n\r', '\n']);
    expect(out).toEqual([{ id: null, event: 'message', data: 'x' }]);
  });
});

describe('formatSse', () => {
  it('round-trips through the parser', () => {
    const wire = formatSse({ id: 42, data: '{"x":"line1\\nline2"}' });
    expect(collect([wire])).toEqual([{ id: '42', event: 'message', data: '{"x":"line1\\nline2"}' }]);
  });
});
