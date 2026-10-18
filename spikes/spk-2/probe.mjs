// spikes/spk-2/probe.mjs — THROWAWAY: OpenAI-compatible provider probes. Never prints the API key.
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));
if (!args['base-url'] || !args.model) {
  console.error('Usage: node probe.mjs --base-url=<url> --model=<id> [--key-env=<ENV>] [--ctx=32000] [--out=<file>]');
  process.exit(2);
}
const baseUrl = args['base-url'].replace(/\/$/, '');
const model = args.model;
const key = args['key-env'] ? process.env[args['key-env']] : undefined;
if (args['key-env'] && !key) { console.error(`env var ${args['key-env']} is empty`); process.exit(2); }
const ctx = Number(args.ctx ?? 32000);
const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };

async function chat(body) {
  const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, ...body }) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text: text.slice(0, 500), headers: Object.fromEntries([...res.headers].filter(([k]) => /ratelimit|retry-after/i.test(k))) };
}

const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function toolCall() {
  const messages = [{ role: 'user', content: 'What is the weather in Lisbon? You must call the get_weather tool.' }];
  const r1 = await chat({ messages, tools });
  const call = r1.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.function?.name !== 'get_weather') return { pass: false, detail: `no tool call (status ${r1.status}): ${r1.text}` };
  let city; try { city = JSON.parse(call.function.arguments).city; } catch { return { pass: false, detail: 'arguments not JSON' }; }
  messages.push(r1.json.choices[0].message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ tempC: 21 }) });
  const r2 = await chat({ messages, tools });
  const content = r2.json?.choices?.[0]?.message?.content ?? '';
  return { pass: /lisbon/i.test(city ?? '') && /21/.test(content), detail: `city=${city}; final=${content.slice(0, 120)}` };
}

async function longContext() {
  const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank today. ';
  const filler = sentence.repeat(Math.ceil((ctx * 4) / sentence.length));
  const doc = `NOTE: The secret code is 4417.\n${filler}`;
  const r = await chat({ messages: [{ role: 'user', content: `${doc}\n\nWhat is the secret code? Answer with digits only.` }] });
  const content = r.json?.choices?.[0]?.message?.content ?? '';
  return { pass: content.includes('4417'), tokensSent: r.json?.usage?.prompt_tokens ?? null, detail: r.status === 200 ? content.slice(0, 60) : r.text };
}

async function jsonSchema() {
  const r = await chat({ messages: [
    { role: 'system', content: 'Reply with exactly one fenced ```json block and nothing else. Schema: {"summary": string, "subtasks": [{"id": string, "description": string}] (min 1), "complexity": "S"|"M"|"L"|"XL"}' },
    { role: 'user', content: 'Plan: add a /health endpoint to an Express app.' } ] });
  const content = r.json?.choices?.[0]?.message?.content ?? '';
  const m = [...content.matchAll(/```json\s*([\s\S]*?)```/g)].pop();
  try {
    const v = JSON.parse(m?.[1] ?? '');
    const ok = typeof v.summary === 'string' && Array.isArray(v.subtasks) && v.subtasks.length > 0 && v.subtasks.every((s) => typeof s.id === 'string' && typeof s.description === 'string') && ['S', 'M', 'L', 'XL'].includes(v.complexity);
    return { pass: ok, detail: ok ? 'valid' : content.slice(0, 200) };
  } catch { return { pass: false, detail: content.slice(0, 200) }; }
}

async function throughput() {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'Write about 300 words on the history of the printing press.' }] }) });
  if (!res.ok) return { ttftMs: null, genTokensPerSec: null, detail: `status ${res.status}` };
  let ttft = null; let chars = 0;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    const text = decoder.decode(chunk);
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try { const d = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''; if (d && ttft === null) ttft = performance.now() - t0; chars += d.length; } catch { /* partial line */ }
    }
  }
  const genSec = (performance.now() - t0 - (ttft ?? 0)) / 1000;
  return { ttftMs: ttft === null ? null : Math.round(ttft), genTokensPerSec: genSec > 0 ? Math.round((chars / 4 / genSec) * 10) / 10 : null };
}

async function burst() {
  const statuses = [];
  let lastHeaders = {};
  for (let i = 0; i < 10; i++) { const r = await chat({ messages: [{ role: 'user', content: `Reply with the number ${i}.` }], max_tokens: 5 }); statuses.push(r.status); lastHeaders = r.headers; }
  return { ok: statuses.every((s) => s === 200), statuses, rateLimitHeaders: lastHeaders };
}

const result = { baseUrl, model, at: new Date().toISOString(), toolCall: await toolCall(), longContext: await longContext(), jsonSchema: await jsonSchema(), throughput: await throughput(), burst: await burst() };
const out = JSON.stringify(result, null, 2);
if (args.out) fs.writeFileSync(args.out, out);
console.log(out);
