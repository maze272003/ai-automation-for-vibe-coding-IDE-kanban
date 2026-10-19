// apps/skill-vault/src/mcp.ts — minimal MCP Streamable-HTTP client (JSON-RPC over POST).
// Handles both `application/json` and `text/event-stream` responses per the transport spec.
import type { PoliteHttpClient } from './http.ts';

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code: number | undefined, data: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

const parseSseBody = (text: string): JsonRpcMessage[] => {
  const messages: JsonRpcMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload) as JsonRpcMessage);
    } catch {
      // Ignore malformed SSE data lines.
    }
  }
  return messages;
};

export type ToolSchema = {
  name: string;
  description?: string;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
};

export class McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  private toolsCache: ToolSchema[] | undefined;
  private initialized = false;
  private readonly endpoint: string;
  private readonly http: PoliteHttpClient;

  constructor(endpoint: string, http: PoliteHttpClient) {
    this.endpoint = endpoint;
    this.http = http;
  }

  private async post(message: JsonRpcMessage, postInitialize = true): Promise<JsonRpcMessage | undefined> {
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
    // The Streamable HTTP revision requires the protocol-version header on requests AFTER
    // initialize; sending it on initialize itself is what some frontends reject.
    if (postInitialize && this.negotiatedVersion !== undefined) {
      headers['mcp-protocol-version'] = this.negotiatedVersion;
    }
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
    const response = await this.http.postJson(this.endpoint, message, headers);
    const session = response.headers.get('mcp-session-id');
    if (session && session.length > 0) this.sessionId = session;
    if (response.body.length === 0) return undefined;
    const text = response.body.toString('utf8');
    const contentType = response.headers.get('content-type') ?? '';
    const messages = contentType.includes('text/event-stream') ? parseSseBody(text) : [JSON.parse(text) as JsonRpcMessage];
    // Return the message matching our request id (SSE may interleave notifications).
    const match = messages.find((m) => m.id === message.id && (m.result !== undefined || m.error !== undefined));
    return match ?? messages.find((m) => m.id === message.id) ?? messages[0];
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const id = this.nextId++;
    const response = await this.post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'aikanban-skill-vault', version: '0.1.0' },
        },
      },
      false,
    );
    if (response?.error) throw new McpError(response.error.message, response.error.code, response.error.data);
    const result = (response?.result ?? {}) as { protocolVersion?: string };
    this.negotiatedVersion = result.protocolVersion ?? '2025-03-26';
    this.initialized = true;
    // Fire-and-forget initialized notification (202 Accepted, empty body expected).
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined);
  }

  async listTools(): Promise<ToolSchema[]> {
    await this.initialize();
    if (this.toolsCache) return this.toolsCache;
    const response = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list' });
    if (response?.error) throw new McpError(response.error.message, response.error.code, response.error.data);
    const result = (response?.result ?? {}) as { tools?: ToolSchema[] };
    this.toolsCache = result.tools ?? [];
    return this.toolsCache;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.initialize();
    const response = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (response?.error) throw new McpError(response.error.message, response.error.code, response.error.data);
    const result = (response?.result ?? {}) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.isError) {
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
      throw new McpError(`MCP tool ${name} returned an error: ${text}`, undefined, result);
    }
    const textItem = result.content?.find((c) => c.type === 'text');
    if (textItem?.text === undefined) return undefined as T;
    try {
      return JSON.parse(textItem.text) as T;
    } catch {
      return textItem.text as T;
    }
  }

  /** Map friendly argument names onto whatever property names a tool's schema declares. */
  static adaptArgs(tool: ToolSchema | undefined, candidates: Record<string, unknown>): Record<string, unknown> {
    if (!tool?.inputSchema?.properties) return candidates;
    const props = Object.keys(tool.inputSchema.properties);
    const out: Record<string, unknown> = {};
    for (const [ourKey, value] of Object.entries(candidates)) {
      const aliases = [ourKey, ...(ARG_ALIASES[ourKey] ?? [])];
      const match = aliases.find((alias) => props.includes(alias));
      if (match !== undefined) out[match] = value;
    }
    return out;
  }
}

const ARG_ALIASES: Record<string, string[]> = {
  query: ['q', 'search', 'keyword', 'keywords'],
  category: ['categorySlug', 'category_slug', 'domain'],
  page: ['pageNumber'],
  limit: ['pageSize', 'perPage'],
  sortBy: ['sort', 'sort_by'],
  id: ['skillId', 'skill_id'],
};
