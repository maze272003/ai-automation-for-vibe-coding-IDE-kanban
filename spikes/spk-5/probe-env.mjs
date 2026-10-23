// spikes/spk-5/probe-env.mjs — THROWAWAY probe. Answers: does OpenCode's shell tool inherit
// the server's environment? If yes, a provider API key must NEVER be placed in the OpenCode
// environment. Verdict line: "P-1 VERDICT: ..." (grep out.log for the canary).
// Evidence uses a scripted local model mock (same SSE shape as spikes/shared/mock-llm.mjs),
// so the run is deterministic and never touches a real credential or the built-in gateway.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Binary resolution: explicit env override first, then the throwaway pinned-CLI vendor dir.
const CANDIDATES = [
  process.env.AIKA_E2E_OPENCODE_EXE,
  path.join(os.tmpdir(), 'opencode', 'spk5-cli', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Temp', 'opencode', 'spk5-cli', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
].filter(Boolean).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (CANDIDATES.length === 0) {
  console.error('P-1 [U]: pinned OpenCode 2.0.32 binary not found. Install with:');
  console.error('  npm install --prefix "%LOCALAPPDATA%\\Temp\\opencode\\spk5-cli" @opencode/cli@2.0.32 --no-audit --no-fund');
  console.error('  then run: node "%LOCALAPPDATA%\\Temp\\opencode\\spk5-cli\\node_modules\\@opencode\\cli\\postinstall.mjs"');
  process.exit(2);
}
const exe = CANDIDATES[0];
console.log(`[probe-env] binary: ${exe}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk5-'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
for (const d of ['data', 'config', 'state', 'cache']) fs.mkdirSync(path.join(root, d), { recursive: true });

const CANARY = 'aik-canary-7f3d9a2b';
const shellCallSeen = { toolCommand: null, toolResult: null };
const scriptLog = [];
const upstream = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model', owned_by: 'mock' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    scriptLog.push(raw);
    fs.writeFileSync(path.join(root, `req-${String(scriptLog.length).padStart(2, '0')}.json`), raw);
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const toolMsgs = Array.isArray(body.messages) ? body.messages.filter((m) => m.role === 'tool') : [];
    const wantsStream = body.stream === true;
    fs.writeFileSync(path.join(root, `req-${String(scriptLog.length).padStart(2, '0')}.headers.json`), JSON.stringify(req.headers, null, 2));
    const finish = (turn) => {
      res.writeHead(200, wantsStream ? { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } : { 'content-type': 'application/json' });
      const id = `chatcmpl-${scriptLog.length}`;
      const created = Math.floor(Date.now() / 1000);
      if (!wantsStream) {
        const message = { role: 'assistant', content: turn.content ?? null };
        if (turn.tool_calls?.length) message.tool_calls = turn.tool_calls.map((tc, i) => ({ id: `call_${scriptLog.length}_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) } }));
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model ?? 'probe-model', choices: [{ index: 0, message, finish_reason: turn.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      const write = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model ?? 'probe-model', choices, ...extra })}\n\n`);
      write([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
      if (turn.content) write([{ index: 0, delta: { content: turn.content }, finish_reason: null }]);
      (turn.tool_calls ?? []).forEach((tc, i) => write([{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${scriptLog.length}_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) } }] }, finish_reason: null }]));
      write([{ index: 0, delta: {}, finish_reason: turn.tool_calls?.length ? 'tool_calls' : 'stop' }]);
      write([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    };
    if (toolMsgs.length === 0) {
      shellCallSeen.toolCommand = 'echo $AIK_CANARY_ENV';
      finish({ tool_calls: [{ name: 'shell', arguments: { command: 'echo $AIK_CANARY_ENV' } }] });
    } else {
      const last = toolMsgs[toolMsgs.length - 1];
      const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      shellCallSeen.toolResult = text;
      finish({ content: `TOOL-ECHO-RESULT: ${text}` });
    }
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;

// ── isolated config (plan shape A; `agents` plural + permission RULES list per SPK-1 S1) ──
const bashPath = fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : undefined;
const cfg = {
  snapshots: false,
  snapshot: false,
  provider: {
    probe: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-token', headers: { 'x-aik-probe': 'env' } },
      models: { 'probe-model': { name: 'Probe' } },
    },
  },
  agents: {
    prober: {
      mode: 'primary',
      model: 'probe/probe-model',
      system: 'Run exactly: echo $AIK_CANARY_ENV\nThen stop.',
      tools: { write: false, edit: false, read: false, grep: false, glob: false },
      permissions: [{ action: 'shell', resource: 'echo *', effect: 'allow' }],
    },
  },
  ...(bashPath ? { shell: bashPath } : {}),
};
console.assert(!JSON.stringify(cfg).includes(CANARY), 'sanity: canary must not come from the config');

// ── isolated environment: every env var redirects to the temp sandbox; canary rides along ──
const env = {
  ...process.env,
  HOME: root, USERPROFILE: root,
  APPDATA: path.join(root, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
  TEMP: root, TMP: root,
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  OPENCODE_CONFIG_DIR: path.join(root, 'config'),
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_FILEWATCHER: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
  ...(bashPath ? { OPENCODE_GIT_BASH_PATH: bashPath } : {}),
  AIK_CANARY_ENV: CANARY,
};

// ── run the agent; capture everything to memory + out.log ──
let out = '';
const proc = spawn(exe, ['run', '--standalone', '--agent', 'prober', '-m', 'probe/probe-model', '--auto', 'run the probe'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', (c) => { out += c; });
proc.stderr.on('data', (c) => { out += c; });
const timer = setTimeout(() => proc.kill(), 120_000);
const exitCode = await new Promise((resolve) => {
  proc.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});
fs.writeFileSync(path.join(root, 'out.log'), out.replace(/\x1b\[[0-9;]*m/g, ''));
fs.writeFileSync(path.join(root, 'script-log.json'), JSON.stringify(scriptLog, null, 2));
upstream.close();

console.log(`[probe-env] exit=${exitCode} requests-to-mock=${scriptLog.length}`);
console.log(`[probe-env] shellCallSeen: ${JSON.stringify(shellCallSeen)}`);

const text = out.replace(/\x1b\[[0-9;]*m/g, '');
if (text.includes(CANARY)) {
  console.log('P-1 VERDICT: the shell DOES see the server environment — the key must never be in an environment.');
} else {
  console.log('P-1 VERDICT: the shell does NOT see the server environment.');
  console.log(`[probe-env] (note: sandbox root ${root}; out.log and req-*.json kept for evidence)`);
}
