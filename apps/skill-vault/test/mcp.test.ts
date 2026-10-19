// apps/skill-vault/test/mcp.test.ts — MCP streamable-HTTP client: handshake, SSE/JSON, errors.
import { describe, expect, it } from 'vitest';
import { PoliteHttpClient } from '../src/http.ts';
import { McpClient, McpError } from '../src/mcp.ts';

const makeClient = (handler: (body: { id?: number | string; method?: string; params?: unknown }, requestCount: number) => { status?: number; contentType?: string; body?: string; headers?: Record<string, string> }) => {
  let requestCount = 0;
  const seen: Array<{ id?: number | string; method?: string }> = [];
  const http = new PoliteHttpClient({
    userAgent: 'test',
    minIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 5_000,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number | string; method?: string };
      seen.push(body);
      const result = handler(body, requestCount);
      return new Response(result.body ?? '', {
        status: result.status ?? 200,
        headers: { 'content-type': result.contentType ?? 'application/json', ...(result.headers ?? {}) },
      });
    }) as unknown as typeof fetch,
  });
  return { client: new McpClient('https://skillsmp.test/mcp', http), seen };
};

describe('McpClient', () => {
  it('initializes, sends the initialized notification and calls tools', async () => {
    const { client, seen } = makeClient((body) => {
      if (body.method === 'initialize') {
        return { headers: { 'mcp-session-id': 'sess-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }) };
      }
      if (body.method === 'tools/list') {
        return {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'search_skills', inputSchema: { required: ['query'], properties: { query: {}, page: {}, limit: {}, category: {} } } }] },
          }),
        };
      }
      if (body.method === 'tools/call') {
        return {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ skills: [], pagination: { hasNext: false } }) }] },
          }),
        };
      }
      return { status: 202, body: '' };
    });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('search_skills');
    const result = await client.callTool<unknown>('search_skills', { query: '', page: 1 });
    expect(result).toEqual({ skills: [], pagination: { hasNext: false } });
    expect(seen[0]?.method).toBe('initialize');
    expect(seen[1]?.method).toBe('notifications/initialized');
  });

  it('parses SSE (text/event-stream) responses', async () => {
    const { client } = makeClient((body) => {
      if (body.method === 'tools/call') {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '"sse-ok"' }] } });
        return { contentType: 'text/event-stream', body: `event: message\ndata: ${payload}\n\n` };
      }
      if (body.method === 'initialize') {
        return { body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      }
      return { status: 202, body: '' };
    });
    await client.initialize();
    const result = await client.callTool<string>('search_skills', {});
    expect(result).toBe('sse-ok');
  });

  it('surfaces JSON-RPC errors as McpError', async () => {
    const { client } = makeClient((body) => {
      if (body.method === 'initialize') return { body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) };
      if (body.method === 'tools/call') {
        return { body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'tool failed' } }) };
      }
      return { status: 202, body: '' };
    });
    await client.initialize();
    await expect(client.callTool('search_skills', {})).rejects.toBeInstanceOf(McpError);
  });

  it('adapts argument names to the tool schema', () => {
    const adapted = McpClient.adaptArgs(
      { name: 'search_skills', inputSchema: { required: ['q'], properties: { q: {}, pageNumber: {}, pageSize: {}, categorySlug: {} } } },
      { query: 'react', category: 'coding', page: 2, limit: 50 },
    );
    expect(adapted).toEqual({ q: 'react', categorySlug: 'coding', pageNumber: 2, pageSize: 50 });
  });
});
