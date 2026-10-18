// spikes/shared/mock-llm.mjs — THROWAWAY spike tool: scripted OpenAI-compatible chat-completions server.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const port = Number(args.port ?? 0);
const recordDir = args.record ? path.resolve(args.record) : null;
const scenario = args.scenario
  ? JSON.parse(fs.readFileSync(path.resolve(args.scenario), 'utf8'))
  : { turns: [] };
let turnIndex = 0;
let requestCount = 0;

function nextTurn() {
  if (turnIndex < scenario.turns.length) return scenario.turns[turnIndex++];
  return scenario.fallback ?? { content: 'OK.' };
}

function toolCalls(turn) {
  return (turn.tool_calls ?? []).map((tc, i) => ({
    id: `call_${requestCount}_${i}`,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
  }));
}

function sendStream(res, model, turn) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = `chatcmpl-${requestCount}`;
  const created = Math.floor(Date.now() / 1000);
  const write = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`);
  write([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  if (turn.content) write([{ index: 0, delta: { content: turn.content }, finish_reason: null }]);
  toolCalls(turn).forEach((tc, i) =>
    write([{ index: 0, delta: { tool_calls: [{ index: i, ...tc }] }, finish_reason: null }]),
  );
  write([{ index: 0, delta: {}, finish_reason: turn.tool_calls?.length ? 'tool_calls' : 'stop' }]);
  write([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}

function sendJson(res, model, turn) {
  const message = { role: 'assistant', content: turn.content ?? null };
  const calls = toolCalls(turn);
  if (calls.length) message.tool_calls = calls;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${requestCount}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    const ids = scenario.models ?? ['mock-model'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'mock' })) }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    requestCount += 1;
    const body = JSON.parse(raw || '{}');
    if (recordDir) {
      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(
        path.join(recordDir, `request-${String(requestCount).padStart(3, '0')}.json`),
        JSON.stringify(body, null, 2),
      );
    }
    const turn = nextTurn();
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.status) {
      res.writeHead(turn.status, { 'content-type': 'application/json', ...(turn.headers ?? {}) });
      res.end(JSON.stringify({ error: { message: turn.errorMessage ?? 'mock error', type: 'mock' } }));
      return;
    }
    (body.stream ? sendStream : sendJson)(res, body.model ?? 'mock-model', turn);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/v1` }));
});
