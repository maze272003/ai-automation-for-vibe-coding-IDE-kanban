// spikes/spk-5/probe-headers.mjs — THROWAWAY probe. Answers: does options.headers reach the
// upstream request for every AI SDK package the catalog uses? One package per protocol family
// is enough. Verdict line: "P-2 VERDICT: ..." plus per-package OK/MISS lines.
// Same throwaway pinned-CLI vendor dir and isolated sandbox env as probe-env.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.AIKA_E2E_OPENCODE_EXE,
  path.join(os.tmpdir(), 'opencode', 'spk5-cli', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Temp', 'opencode', 'spk5-cli', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
].filter(Boolean).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (CANDIDATES.length === 0) {
  console.error('P-2 [U]: pinned OpenCode 2.0.32 binary not found. Install with:');
  console.error('  npm install --prefix "%LOCALAPPDATA%\\Temp\\opencode\\spk5-cli" @opencode/cli@2.0.32 --no-audit --no-fund');
  console.error('  then run: node "%LOCALAPPDATA%\\Temp\\opencode\\spk5-cli\\node_modules\\@opencode\\cli\\postinstall.mjs"');
  process.exit(2);
}
const exe = CANDIDATES[0];
console.log(`[probe-headers] binary: ${exe}`);

const PACKAGES = ['@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/openai'];

const seen = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ pkg: req.headers['x-aik-provider'] ?? null, path: req.url, headers: Object.keys(req.headers) });
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const wantsStream = body.stream === true;
    res.writeHead(200, { 'content-type': wantsStream ? 'text/event-stream' : 'application/json' });
    const id = `chatcmpl-${seen.length}`;
    if (!wantsStream) {
      res.end(JSON.stringify({ id, object: 'chat.completion', created: 0, model: 'm1', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }));
      return;
    }
    const write = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'm1', choices, ...extra })}\n\n`);
    write([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    write([{ index: 0, delta: { content: 'pong' }, finish_reason: null }]);
    write([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    write([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;

for (const pkg of PACKAGES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk5-h-'));
  for (const d of ['data', 'config', 'state', 'cache', 'work']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const cfg = {
    snapshots: false,
    snapshot: false,
    provider: {
      probe: {
        npm: pkg,
        options: { baseURL: `http://127.0.0.1:${port}`, apiKey: 'local-token', headers: { 'x-aik-provider': pkg } },
        models: { m1: { name: 'M1' } },
      },
    },
  };
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
  };
  let out = '';
  const proc = spawn(exe, ['run', '--standalone', '-m', 'probe/m1', '--auto', 'hi'], { env, cwd: path.join(root, 'work'), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => (out += c));
  proc.stderr.on('data', (c) => (out += c));
  const exitCode = await new Promise((r) => {
    const t = setTimeout(() => { proc.kill(); r(null); }, 60_000);
    proc.on('exit', (code) => { clearTimeout(t); r(code); });
  });
  fs.writeFileSync(path.join(root, 'out.log'), out.replace(/\x1b\[[0-9;]*m/g, ''));
  console.log(`[probe-headers] ${pkg}: exit=${exitCode} requests=${seen.filter((s) => s.pkg === pkg).length}`);
}

upstream.close();
const byPkg = new Map();
for (const s of seen) if (s.pkg) byPkg.set(s.pkg, s);
for (const pkg of PACKAGES) {
  console.log(`${byPkg.has(pkg) ? 'OK  ' : 'MISS'} ${pkg}${byPkg.has(pkg) ? ` -> ${byPkg.get(pkg).path}` : ''}`);
}
console.log(byPkg.size === PACKAGES.length
  ? 'P-2 VERDICT: every probed package forwards options.headers.'
  : 'P-2 VERDICT: some packages do NOT forward options.headers — the gateway must fall back to model-id routing for those.');
