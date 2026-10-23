import { describe, expect, it } from 'vitest';
import { buildUpstreamCall, buildUpstreamUrl, localToken, stripAuthHeaders } from '../src/gateway/upstream.ts';

describe('buildUpstreamUrl', () => {
  it('joins the base URL with the incoming path and query', () => {
    expect(buildUpstreamUrl('https://api.z.ai/api/paas/v4', '/chat/completions', '')).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(buildUpstreamUrl('https://api.anthropic.com/v1', '/messages', '')).toBe('https://api.anthropic.com/v1/messages');
    expect(buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', '/models/gemini-3-pro:streamGenerateContent', 'alt=sse')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse',
    );
  });

  it('does not double the version segment', () => {
    expect(buildUpstreamUrl('https://api.openai.com/v1', '/responses', '')).toBe('https://api.openai.com/v1/responses');
    expect(buildUpstreamUrl('http://127.0.0.1:11434/v1', '/chat/completions', '')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});

describe('stripAuthHeaders', () => {
  it('removes every credential header and keeps the rest', () => {
    const headers = {
      authorization: 'Bearer local-token',
      'x-api-key': 'local-token',
      'x-goog-api-key': 'local-token',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    expect(stripAuthHeaders(headers)).toEqual({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
  });
});

describe('localToken', () => {
  it('reads the token from any of the three header styles and the query', () => {
    expect(localToken({ authorization: 'Bearer abc' }, '')).toBe('abc');
    expect(localToken({ 'x-api-key': 'abc' }, '')).toBe('abc');
    expect(localToken({ 'x-goog-api-key': 'abc' }, '')).toBe('abc');
    expect(localToken({}, 'key=abc')).toBe('abc');
    expect(localToken({}, '')).toBeNull();
  });
});

describe('buildUpstreamCall', () => {
  const base = { path: '/chat/completions', query: '', headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' } };

  it('injects a bearer credential', () => {
    const call = buildUpstreamCall({ baseUrl: 'https://api.z.ai/api/paas/v4', auth: 'bearer', key: 'sk-real' }, base);
    expect(call.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-real');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('injects an x-api-key credential and keeps the anthropic version', () => {
    const call = buildUpstreamCall(
      { baseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key', key: 'sk-ant-real' },
      { path: '/messages', query: '', headers: { 'x-api-key': 'local-token', 'anthropic-version': '2023-06-01' } },
    );
    expect(call.headers['x-api-key']).toBe('sk-ant-real');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('injects a google credential', () => {
    const call = buildUpstreamCall(
      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', auth: 'x-goog-api-key', key: 'AIza-real' },
      { path: '/models/m1:streamGenerateContent', query: 'alt=sse', headers: { 'x-goog-api-key': 'local-token' } },
    );
    expect(call.headers['x-goog-api-key']).toBe('AIza-real');
  });

  it('injects a placeholder when the provider needs no key', () => {
    const call = buildUpstreamCall({ baseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', key: null }, base);
    expect(call.headers.authorization).toBe('Bearer local');
  });
});
