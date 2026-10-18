# Phase 0: Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any product code depends on them, retire the four biggest unknowns in the approved spec:
- the OpenCode v2 integration;
- free-provider viability;
- Windows Job Object containment;
- the GitHub App device flow plus credential-helper push.

**Architecture:**
- Spike code is **throwaway**. It lives under `spikes/` and is committed for reference only. It is never imported by `apps/` or `packages/`.
- Each spike produces a report at `docs/superpowers/spikes/SPK-<n>.md` containing evidence (commands, outputs, versions), findings marked [V]/[I]/[U], a go/no-go verdict, and any spec amendments needed.
- One shared scripted mock LLM (`spikes/shared/mock-llm.mjs`) drives OpenCode deterministically and offline.

**Tech Stack:** Node 24 (plain `.mjs`, no build step), `@opencode/cli` **2.0.32**, Go (latest stable via winget) with `golang.org/x/sys/windows`, `@napi-rs/keyring` 2.1.1, Git for Windows 2.54, PowerShell.

**Spec:** `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md`. See §18 (OpenCode), §9/§18.7 (providers and gateway), §21.4 (Job Objects), §11–§14 (GitHub), and the SPK-1…SPK-4 cards in §27.

## Global Constraints

- **Never read, print, copy or modify** the user's personal OpenCode data: `~/.config/opencode/*`, `~/.local/share/opencode/*`, `auth.json`, `service.json`.
- **Never write** into the user's real skill directories (`~/.claude/skills`, `~/.agents/skills`) or their real home. Leakage tests use a **temporary HOME**.
- **Secrets** (API keys, GitHub tokens, client IDs aren't secret but treat them carefully) are never written to files in the repo, never printed in full, and never passed as command-line arguments. They are read from environment variables or Windows Credential Manager only.
- **USER ACTION** steps are things only the human can do: install software, create accounts, register a GitHub App, create a scratch repo. The executor must stop and ask before each one and must not try to do them itself.
- **GitHub work** happens only on a **scratch** repository the user creates for this purpose (`aik-spike-scratch`). It never touches a real repository.
- **Pins:** `@opencode/cli@2.0.32` and `@napi-rs/keyring@2.1.1` are installed with `--save-exact` into each spike's own folder, never globally.
- **Git safety:** add `spikes/**/node_modules/`, `spikes/**/out/`, `spikes/**/runtime/` and `spikes/**/*.exe` to `.gitignore`. Commit scripts and reports only.
- Phase 1 (`2026-10-18-phase-1-walking-skeleton.md`) does **not** depend on these spikes. They gate Phase 2/3 work.

## Review Focus

These are the conditions most likely to make a spike's conclusion wrong without anyone noticing. Each line names the condition, the behaviour a careful reader expects, and the spike step that pins it.

1. **OpenCode silently falls back to the user's global config or credentials** when the isolation environment variables are wrong. Expected: the isolated server sees *zero* personal providers or skills. Pinned by SPK-1 Step 6 (provider list must contain only `mock`).
2. **A permission "denial" is only the model being told no, while the file still changes.** Expected: the file on disk is byte-identical after the attempt. Pinned by SPK-1 Steps 8–9 (SHA-256 of the target file before and after).
3. **Grandchild processes survive** because they escaped the job: breakaway, or spawned before assignment. Expected: no descendants after the helper dies. Pinned by SPK-3 Step 5 (PID liveness checks on grandchildren).
4. **A provider passes the tool-call probe once but is too rate-limited to complete a single story.** Expected: limits are recorded and the verdict reflects about 50 calls per story. Pinned by SPK-2 Step 6 (a 10-call burst in the probe).
5. **The GitHub token leaks into a process command line or Git Credential Manager** during push. Expected: not present in either. Pinned by SPK-4 Step 7 (command-line snapshot plus `cmdkey` diff).

---

## File Structure

```
spikes/
├─ README.md                      # what spikes are, "never import from apps/packages"
├─ shared/
│  ├─ mock-llm.mjs                # scripted OpenAI-compatible server (record / script / fault modes)
│  └─ mock-llm.selftest.mjs       # smoke test for the mock
├─ spk-1/
│  ├─ package.json                # pins @opencode/cli 2.0.32
│  ├─ harness.mjs                 # isolated server lifecycle + experiments a..g
│  └─ scenarios/*.json            # scripted model turns
├─ spk-2/
│  └─ probe.mjs                   # tool-call / long-context / JSON / throughput / burst probes
├─ spk-3/
│  ├─ helper/go.mod, main.go      # Job Object runner prototype
│  ├─ fixtures/tree.mjs, alloc.mjs, echo.mjs, parent.mjs
│  └─ run-experiments.mjs
└─ spk-4/
   ├─ package.json                # pins @napi-rs/keyring 2.1.1
   ├─ gh.mjs                      # shared GitHub REST helpers
   ├─ device-flow.mjs, refresh.mjs, list-repos.mjs
   ├─ cred-helper.mjs             # git credential helper prototype (named pipe + nonce)
   ├─ push.mjs                    # clone/commit/push via helper + leak checks
   └─ merge-guard.mjs             # PR + merge with stale/current sha
docs/superpowers/spikes/SPK-1.md … SPK-4.md   # reports
```

---

### Task 1: Spike workspace and scripted mock LLM

**Files:**
- Create: `spikes/README.md`
- Create: `spikes/shared/mock-llm.mjs`
- Create: `spikes/shared/mock-llm.selftest.mjs`
- Create: `.gitignore`

**Interfaces:**
- Produces: `node spikes/shared/mock-llm.mjs [--port=N] [--record=<dir>] [--scenario=<file>]`. On start it prints one JSON line `{"url":"http://127.0.0.1:<port>/v1"}`.
  - Scenario file format: `{ "models"?: string[], "turns": Turn[], "fallback"?: Turn }`.
  - `Turn = { content?: string, tool_calls?: {name: string, arguments: object}[], delayMs?: number, status?: number, headers?: object, errorMessage?: string }`.
  - Each `POST /v1/chat/completions` consumes the next turn. Streaming (`stream: true`) and non-streaming are both supported.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.log
spikes/**/node_modules/
spikes/**/out/
spikes/**/runtime/
spikes/**/*.exe
.env*
```

- [ ] **Step 2: Create `spikes/README.md`**

```markdown
# Spikes (throwaway)

Code here answers questions for `docs/superpowers/spikes/SPK-*.md`. It is committed for reference only.
**Never import anything from `spikes/` into `apps/` or `packages/`.** Reports, not code, are the deliverable.
```

- [ ] **Step 3: Write the mock LLM**

```js
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
```

- [ ] **Step 4: Write the self-test**

```js
// spikes/shared/mock-llm.selftest.mjs — THROWAWAY
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-mock-selftest-'));
const scenarioFile = path.join(dir, 's.json');
fs.writeFileSync(
  scenarioFile,
  JSON.stringify({
    turns: [
      { tool_calls: [{ name: 'read', arguments: { filePath: 'a.txt' } }] },
      { status: 429, headers: { 'retry-after': '1' } },
      { content: 'done' },
    ],
  }),
);
const child = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-llm.mjs'), `--scenario=${scenarioFile}`, `--record=${dir}`]);
const { url } = JSON.parse(await new Promise((r) => readline.createInterface({ input: child.stdout }).once('line', r)));
const post = (body) => fetch(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const r1 = await (await post({ model: 'm', messages: [] })).json();
if (r1.choices[0].message.tool_calls[0].function.name !== 'read') throw new Error('turn 1: expected read tool call');
const r2 = await post({ model: 'm', messages: [] });
if (r2.status !== 429 || r2.headers.get('retry-after') !== '1') throw new Error('turn 2: expected 429 with retry-after');
const r3 = await post({ model: 'm', messages: [], stream: true });
const text = await r3.text();
if (!text.includes('"content":"done"') || !text.trim().endsWith('data: [DONE]')) throw new Error('turn 3: bad stream');
if (fs.readdirSync(dir).filter((f) => f.startsWith('request-')).length !== 3) throw new Error('expected 3 recorded requests');
child.kill();
console.log('mock-llm selftest: PASS');
```

- [ ] **Step 5: Run the self-test**

Run: `node spikes/shared/mock-llm.selftest.mjs`
Expected: `mock-llm selftest: PASS`

- [ ] **Step 6: Commit**

```bash
git add .gitignore spikes/README.md spikes/shared
git commit -m "spike: shared scripted mock LLM for Phase 0 experiments"
```

---

### Task 2: SPK-1, OpenCode pinned isolated server

**Files:**
- Create: `spikes/spk-1/package.json`
- Create: `spikes/spk-1/harness.mjs`
- Create: `spikes/spk-1/scenarios/hello.json`, `reviewer-edit.json`, `implementer-escape.json`, `stall.json`
- Create: `docs/superpowers/spikes/SPK-1.md`

**Interfaces:**
- Consumes: `spikes/shared/mock-llm.mjs` (Task 1).
- Produces:
  - A report that answers spec questions **Q-4** (shell pinning key, session-deletion operation, `~/.agents/skills` leakage) and **Q-5** (per-session `permissions` semantics).
  - A go/no-go on server mode vs the `run --format json` fallback.
  - The vendored `spikes/spk-1/out/openapi.json`, which is copied to `docs/superpowers/spikes/opencode-2.0.32-openapi.json`.

- [ ] **Step 1: Pin and install OpenCode into the spike folder**

```json
// spikes/spk-1/package.json
{ "name": "aik-spk-1", "private": true, "type": "module", "dependencies": { "@opencode/cli": "2.0.32" } }
```

Run: `npm install --prefix spikes/spk-1 --save-exact`
Then run: `spikes/spk-1/node_modules/@opencode/cli/bin/opencode.exe --version`
Expected: `opencode v2.0.32`. If the binary path differs, record the real path in the report and use it in `harness.mjs` (`OPENCODE_EXE`).

- [ ] **Step 2: Write the scenarios**

The tool names and argument keys below are the v1 names, adjusted for v2 renames (`bash→shell`). Step 7 records the real ones. If they differ, edit these files before Steps 8–10.

```json
// spikes/spk-1/scenarios/hello.json
{ "turns": [ { "content": "Hello from mock." } ] }
```

```json
// spikes/spk-1/scenarios/reviewer-edit.json
{ "turns": [
  { "tool_calls": [ { "name": "edit", "arguments": { "filePath": "target.txt", "oldString": "original", "newString": "TAMPERED" } } ] },
  { "tool_calls": [ { "name": "write", "arguments": { "filePath": "target.txt", "content": "TAMPERED" } } ] },
  { "content": "Review complete." } ] }
```

```json
// spikes/spk-1/scenarios/implementer-escape.json
{ "turns": [
  { "tool_calls": [ { "name": "shell", "arguments": { "command": "git push origin HEAD", "description": "push" } } ] },
  { "tool_calls": [ { "name": "write", "arguments": { "filePath": "../outside.txt", "content": "ESCAPED" } } ] },
  { "tool_calls": [ { "name": "read", "arguments": { "filePath": ".env" } } ] },
  { "content": "Done." } ] }
```

```json
// spikes/spk-1/scenarios/stall.json
{ "turns": [ { "delayMs": 120000, "content": "late" } ] }
```

- [ ] **Step 3: Write the harness**

```js
// spikes/spk-1/harness.mjs — THROWAWAY: isolated OpenCode server experiments.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HERE = import.meta.dirname;
const OPENCODE_EXE = path.join(HERE, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
const MOCK = path.join(HERE, '..', 'shared', 'mock-llm.mjs');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const firstLine = (stream) => new Promise((r) => readline.createInterface({ input: stream }).once('line', r));

function gitBashPath() {
  const gitExe = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  return path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe');
}

export function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk1-')));
  const home = path.join(root, 'home');
  const work = path.join(root, 'parent', 'worktree');
  for (const d of ['data', 'config', 'state', 'cache', 'db', 'tmp']) fs.mkdirSync(path.join(root, 'oc', d), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  // Canary: personal-skill locations inside a TEMP home (never the real home).
  for (const p of ['.claude/skills/canary-claude', '.agents/skills/canary-agents', '.config/opencode/skills/canary-config']) {
    fs.mkdirSync(path.join(home, p), { recursive: true });
    fs.writeFileSync(path.join(home, p, 'SKILL.md'), `---\nname: ${path.basename(p)}\ndescription: CANARY-SKILL-${path.basename(p)}\n---\nCANARY\n`);
  }
  fs.writeFileSync(path.join(root, 'parent', 'AGENTS.md'), 'CANARY-PARENT-AGENTS-MD: if you can read this, parent instructions leaked.\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
  fs.writeFileSync(path.join(work, 'target.txt'), 'original\n');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=canary-env-secret\n');
  execFileSync('git', ['-c', 'user.name=spike', '-c', 'user.email=spike@localhost', 'add', '.'], { cwd: work });
  execFileSync('git', ['-c', 'user.name=spike', '-c', 'user.email=spike@localhost', 'commit', '-q', '-m', 'init'], { cwd: work });
  return { root, home, work };
}

export function configContent(mockUrl) {
  const allow = (action, resource = '*') => ({ action, resource, effect: 'allow' });
  const deny = (action, resource = '*') => ({ action, resource, effect: 'deny' });
  return {
    snapshots: false,
    providers: {
      mock: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: mockUrl, apiKey: 'spike-not-a-secret' },
        models: { 'mock-model': { capabilities: { tools: true }, limit: { context: 131072, output: 8192 } } },
      },
    },
    permissions: [deny('*')],
    agents: {
      'aik-reviewer': {
        mode: 'primary', model: 'mock/mock-model', system: 'You are a read-only code reviewer.',
        permissions: [allow('read'), allow('glob'), allow('grep'), deny('read', '**/.env*')],
      },
      'aik-implementer': {
        mode: 'primary', model: 'mock/mock-model', system: 'You implement changes in this repository.',
        permissions: [
          allow('read'), allow('glob'), allow('grep'), allow('edit'),
          allow('shell', 'npm run *'),
          deny('shell', 'git push*'), deny('shell', 'git commit*'),
          deny('external_directory'), deny('read', '**/.env*'),
        ],
      },
    },
  };
}

export async function startMock(scenarioFile, recordDir) {
  const args = [MOCK, `--scenario=${scenarioFile}`];
  if (recordDir) args.push(`--record=${recordDir}`);
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const { url } = JSON.parse(await firstLine(proc.stdout));
  return { proc, url };
}

export async function startServer(sb, mockUrl) {
  const password = crypto.randomBytes(32).toString('base64url');
  const oc = (d) => path.join(sb.root, 'oc', d);
  const env = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, ComSpec: process.env.ComSpec,
    PATH: [path.join(process.env.SystemRoot, 'System32'), path.dirname(process.execPath), path.dirname(execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim())].join(';'),
    TEMP: oc('tmp'), TMP: oc('tmp'),
    USERPROFILE: sb.home, HOME: sb.home, APPDATA: path.join(sb.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(sb.home, 'AppData', 'Local'),
    XDG_DATA_HOME: oc('data'), XDG_CONFIG_HOME: oc('config'), XDG_STATE_HOME: oc('state'), XDG_CACHE_HOME: oc('cache'),
    OPENCODE_DB: path.join(oc('db'), 'opencode.db'),
    OPENCODE_CONFIG_DIR: oc('config'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent(mockUrl)),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
    OPENCODE_GIT_BASH_PATH: gitBashPath(),
    OPENCODE_PASSWORD: password,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0',
  };
  const t0 = Date.now();
  const proc = spawn(OPENCODE_EXE, ['serve', '--stdio', '--port', '0', '--print-logs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.pipe(fs.createWriteStream(path.join(OUT, `server-${Date.now()}.log`)));
  const line = await firstLine(proc.stdout);
  const { url } = JSON.parse(line);
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  const api = async (method, p, body) => {
    const res = await fetch(new URL(p, url), { method, headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': sb.work }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  for (let i = 0; i < 100; i++) {
    const r = await api('GET', '/api/session/active').catch(() => ({ status: 0 }));
    if (r.status === 200) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  return { proc, url, api, readyMs: Date.now() - t0, env };
}

export async function waitIdle(api, sessionID, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', '/api/session/active');
    const active = JSON.stringify(r.body);
    if (!active.includes(sessionID)) return Date.now() - t0;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return -1;
}

async function runSession(sb, server, agent, prompt) {
  const id = `ses_spk1${crypto.randomBytes(6).toString('hex')}`;
  const created = await server.api('POST', '/api/session', { id, location: { directory: sb.work }, agent, model: 'mock/mock-model', title: `spk1 ${agent}` });
  save(`session-create-${agent}.json`, created);
  const prompted = await server.api('POST', `/api/session/${id}/prompt`, { parts: [{ type: 'text', text: prompt }] });
  save(`session-prompt-${agent}.json`, prompted);
  const idleAfterMs = await waitIdle(server.api, id, 60000);
  const messages = await server.api('GET', `/api/session/${id}/message`);
  save(`session-messages-${agent}.json`, messages);
  return { id, idleAfterMs, messages };
}

const experiments = {
  // a: readiness, OpenAPI, operation inventory
  async a() {
    const sb = makeSandbox();
    const mock = await startMock(path.join(HERE, 'scenarios', 'hello.json'));
    const server = await startServer(sb, mock.url);
    const spec = await server.api('GET', '/openapi.json');
    save('openapi.json', spec.body);
    const ops = Object.entries(spec.body.paths ?? {}).flatMap(([p, m]) => Object.entries(m).map(([verb, op]) => `${verb.toUpperCase()} ${p} ${op.operationId ?? ''}`));
    save('operations.txt', ops.join('\n'));
    console.log({ readyMs: server.readyMs, operations: ops.length });
    server.proc.stdin.end(); mock.proc.kill();
  },
  // b: record what OpenCode sends to the model (tool names + schemas)
  async b() {
    const sb = makeSandbox();
    const mock = await startMock(path.join(HERE, 'scenarios', 'hello.json'), path.join(OUT, 'recorded-b'));
    const server = await startServer(sb, mock.url);
    const r = await runSession(sb, server, 'aik-implementer', 'Say hello.');
    const req = JSON.parse(fs.readFileSync(path.join(OUT, 'recorded-b', 'request-001.json'), 'utf8'));
    save('tools.json', (req.tools ?? []).map((t) => ({ name: t.function?.name, parameters: t.function?.parameters })));
    const systemText = JSON.stringify(req.messages ?? []);
    save('canary-check.json', {
      idleAfterMs: r.idleAfterMs,
      leakedClaudeSkill: systemText.includes('CANARY-SKILL-canary-claude'),
      leakedAgentsSkill: systemText.includes('CANARY-SKILL-canary-agents'),
      leakedConfigSkill: systemText.includes('CANARY-SKILL-canary-config'),
      leakedParentAgentsMd: systemText.includes('CANARY-PARENT-AGENTS-MD'),
    });
    server.proc.stdin.end(); mock.proc.kill();
  },
  // c: reviewer cannot modify files
  async c() {
    const sb = makeSandbox();
    const before = sha256(path.join(sb.work, 'target.txt'));
    const mock = await startMock(path.join(HERE, 'scenarios', 'reviewer-edit.json'), path.join(OUT, 'recorded-c'));
    const server = await startServer(sb, mock.url);
    const r = await runSession(sb, server, 'aik-reviewer', 'Review target.txt');
    const after = sha256(path.join(sb.work, 'target.txt'));
    save('reviewer-result.json', { unchanged: before === after, idleAfterMs: r.idleAfterMs, gitStatus: execFileSync('git', ['status', '--porcelain'], { cwd: sb.work, encoding: 'utf8' }) });
    server.proc.stdin.end(); mock.proc.kill();
  },
  // d: implementer cannot push, write outside worktree, or read .env
  async d() {
    const sb = makeSandbox();
    const outside = path.join(path.dirname(sb.work), 'outside.txt');
    const mock = await startMock(path.join(HERE, 'scenarios', 'implementer-escape.json'), path.join(OUT, 'recorded-d'));
    const server = await startServer(sb, mock.url);
    const r = await runSession(sb, server, 'aik-implementer', 'Do the task.');
    const recorded = fs.readdirSync(path.join(OUT, 'recorded-d')).map((f) => fs.readFileSync(path.join(OUT, 'recorded-d', f), 'utf8')).join('\n');
    save('implementer-escape.json', {
      outsideFileExists: fs.existsSync(outside),
      envContentReachedModel: recorded.includes('canary-env-secret'),
      idleAfterMs: r.idleAfterMs,
    });
    server.proc.stdin.end(); mock.proc.kill();
  },
  // e: interrupt a stalled session; kill the server tree
  async e() {
    const sb = makeSandbox();
    const mock = await startMock(path.join(HERE, 'scenarios', 'stall.json'));
    const server = await startServer(sb, mock.url);
    const id = `ses_spk1${crypto.randomBytes(6).toString('hex')}`;
    await server.api('POST', '/api/session', { id, location: { directory: sb.work }, agent: 'aik-implementer', model: 'mock/mock-model' });
    await server.api('POST', `/api/session/${id}/prompt`, { parts: [{ type: 'text', text: 'go' }] });
    await new Promise((r) => setTimeout(r, 2000));
    const t0 = Date.now();
    const intr = await server.api('POST', `/api/session/${id}/interrupt`);
    const idleMs = await waitIdle(server.api, id, 30000);
    const pid = server.proc.pid;
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    await new Promise((r) => setTimeout(r, 1500));
    const tasklist = execFileSync('tasklist', ['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV'], { encoding: 'utf8' });
    save('interrupt.json', { interruptStatus: intr.status, idleAfterInterruptMs: idleMs, measuredFromCallMs: Date.now() - t0, opencodeProcessesAfterKill: tasklist });
    mock.proc.kill();
  },
  // f: stdin close shuts the server down
  async f() {
    const sb = makeSandbox();
    const mock = await startMock(path.join(HERE, 'scenarios', 'hello.json'));
    const server = await startServer(sb, mock.url);
    const t0 = Date.now();
    const exited = new Promise((r) => server.proc.once('exit', (code) => r({ code, ms: Date.now() - t0 })));
    server.proc.stdin.end();
    save('stdin-close.json', await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: null, ms: -1 }), 15000))]));
    mock.proc.kill();
  },
  // g: provider isolation — only the mock provider may be visible
  async g() {
    const sb = makeSandbox();
    const mock = await startMock(path.join(HERE, 'scenarios', 'hello.json'));
    const server = await startServer(sb, mock.url);
    const spec = JSON.parse(fs.readFileSync(path.join(OUT, 'openapi.json'), 'utf8'));
    const providerPaths = Object.keys(spec.paths).filter((p) => /provider|model|config/i.test(p));
    const results = {};
    for (const p of providerPaths.filter((p) => !p.includes('{'))) results[p] = (await server.api('GET', p)).body;
    save('provider-isolation.json', results);
    server.proc.stdin.end(); mock.proc.kill();
  },
};

const name = process.argv[2];
if (!experiments[name]) { console.error(`usage: node harness.mjs <${Object.keys(experiments).join('|')}>`); process.exit(2); }
await experiments[name]();
```

- [ ] **Step 4: Run experiment a (readiness and OpenAPI inventory)**

Run: `node spikes/spk-1/harness.mjs a`
Expected:
- Prints `{ readyMs: <number>, operations: <number> }`.
- `spikes/spk-1/out/openapi.json` and `operations.txt` exist.
- `operations.txt` contains `POST /api/session`, `POST /api/session/{sessionID}/prompt`, `POST /api/session/{sessionID}/interrupt`, `GET /api/event`, `POST /api/session/{sessionID}/permission/{requestID}/reply`.

If `POST /api/session` returns a 4xx in later steps, open `openapi.json` and correct the request bodies in `harness.mjs` (`runSession`) to match the schema. Record every correction in the report.

- [ ] **Step 5: Find the session-deletion operation and the shell configuration key (Q-4)**

Run (PowerShell): `Select-String -Path spikes/spk-1/out/operations.txt -Pattern 'delete','DELETE'`
Then search the config schema:
- Run: `curl.exe -s https://opencode.ai/v2/config.json -o spikes/spk-1/out/config-schema.json` (public schema; if this URL 404s, also try `https://opencode.ai/config.json` and record which one works).
- Then: `Select-String -Path spikes/spk-1/out/config-schema.json -Pattern '"shell"' -Context 0,8`

Expected: you can name (1) the operation ID that deletes a session and (2) the config key that pins the shell executable. Write both into the report. If either doesn't exist, write "not available in 2.0.32" and the workaround (`OPENCODE_GIT_BASH_PATH` env var for the shell).

- [ ] **Step 6: Run experiments b and g (canary leakage and provider isolation)**

Run: `node spikes/spk-1/harness.mjs b`, then `node spikes/spk-1/harness.mjs g`
Expected:
- `out/canary-check.json` has all four `leaked*` fields `false`.
- `out/tools.json` lists the tool names and parameter schemas.
- `out/provider-isolation.json` shows **only** the `mock` provider; no `zai-coding-plan` or other personal providers.

If any `leaked*` field is `true`, this is a **finding** (record it). Do not try to fix OpenCode.

- [ ] **Step 7: Align the scenarios with the real tool schema**

Open `spikes/spk-1/out/tools.json`. If the names or argument keys used in `scenarios/*.json` (`edit`: `filePath/oldString/newString`; `write`: `filePath/content`; `shell`: `command/description`; `read`: `filePath`) differ, edit the scenario files to match exactly. Record the final tool table in the report.

- [ ] **Step 8: Run experiment c (reviewer can't edit)**

Run: `node spikes/spk-1/harness.mjs c`
Expected: `out/reviewer-result.json` has `"unchanged": true` and an empty `gitStatus`.
Also check `out/session-messages-aik-reviewer.json` and record how the denial appears (tool error text or permission event).

- [ ] **Step 9: Run experiment d (implementer escape attempts)**

Run: `node spikes/spk-1/harness.mjs d`
Expected: `out/implementer-escape.json` has `"outsideFileExists": false` and `"envContentReachedModel": false`. `out/session-messages-aik-implementer.json` shows the `git push` shell call denied.

- [ ] **Step 10: Run experiments e and f (interrupt, kill tree, stdin shutdown)**

Run: `node spikes/spk-1/harness.mjs e`, then `node spikes/spk-1/harness.mjs f`
Expected:
- `out/interrupt.json` has `idleAfterInterruptMs` between 0 and 30000, and `opencodeProcessesAfterKill` contains no `opencode.exe` rows. A CSV header-only or "No tasks" output is fine, as long as no OpenCode processes from **other** sessions (the user's own) were running. If the user's own OpenCode was running, compare PIDs instead and note this.
- `out/stdin-close.json` has `code` not null and `ms` < 15000.

- [ ] **Step 11: Test per-session permissions semantics (Q-5)**

Add this experiment to `harness.mjs` (append to `experiments`):

```js
  // h: per-session permissions passed on create — additive or overriding?
  async h() {
    const sb = makeSandbox();
    const before = sha256(path.join(sb.work, 'target.txt'));
    const mock = await startMock(path.join(HERE, 'scenarios', 'reviewer-edit.json'), path.join(OUT, 'recorded-h'));
    const server = await startServer(sb, mock.url);
    const id = `ses_spk1${crypto.randomBytes(6).toString('hex')}`;
    const created = await server.api('POST', '/api/session', {
      id, location: { directory: sb.work }, agent: 'aik-reviewer', model: 'mock/mock-model',
      permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
    });
    await server.api('POST', `/api/session/${id}/prompt`, { parts: [{ type: 'text', text: 'Review' }] });
    await waitIdle(server.api, id, 60000);
    save('session-permissions.json', { createStatus: created.status, sessionAllowEditOverrodeAgentDeny: sha256(path.join(sb.work, 'target.txt')) !== before });
    server.proc.stdin.end(); mock.proc.kill();
  },
```

Run: `node spikes/spk-1/harness.mjs h`
Expected: `out/session-permissions.json` exists.
- If `sessionAllowEditOverrodeAgentDeny` is `true`, session rules come **after** agent rules. In that case **the orchestrator must never pass allow rules per session**; this is a design constraint to record.
- If it is `false`, agent denies win.

Record which, in the report.

- [ ] **Step 12: Write the report**

Create `docs/superpowers/spikes/SPK-1.md`:

```markdown
# SPK-1 — OpenCode pinned isolated server (2.0.32)

**Date:** <execution date> · **Executor:** <name> · **Binary:** spikes/spk-1/node_modules/@opencode/cli/bin/opencode.exe (`--version` output: …)

## Results
| # | Question | Result | Evidence | Marker |
|---|---|---|---|---|
| 1 | Server ready time | … ms | out/… | V |
| 2 | Session/prompt/interrupt/event/permission-reply operations exist | … | out/operations.txt | V |
| 3 | Session-deletion operation (Q-4) | … | out/operations.txt | V/U |
| 4 | Shell pinning config key (Q-4) | … | out/config-schema.json | V/U |
| 5 | Canary leakage (claude/agents/config skills, parent AGENTS.md) | … | out/canary-check.json | V |
| 6 | Provider isolation (only `mock` visible) | … | out/provider-isolation.json | V |
| 7 | Reviewer edit/write denied, file unchanged | … | out/reviewer-result.json | V |
| 8 | Implementer: git push denied / outside write blocked / .env not read | … | out/implementer-escape.json | V |
| 9 | Interrupt → idle time; taskkill /T leaves no opencode.exe | … | out/interrupt.json | V |
| 10 | stdin close → exit | … | out/stdin-close.json | V |
| 11 | Per-session permissions semantics (Q-5) | … | out/session-permissions.json | V |
| 12 | Tool names + argument keys | (table) | out/tools.json | V |

## Corrections needed to spec §18
- …

## Verdict
Server mode: GO / NO-GO (if NO-GO: fall back to `run --standalone --format json`; reasons…)
```

Fill every `…` with observed values. Copy `spikes/spk-1/out/openapi.json` to `docs/superpowers/spikes/opencode-2.0.32-openapi.json`.

- [ ] **Step 13: Commit**

```bash
git add spikes/spk-1/package.json spikes/spk-1/package-lock.json spikes/spk-1/harness.mjs spikes/spk-1/scenarios docs/superpowers/spikes/SPK-1.md docs/superpowers/spikes/opencode-2.0.32-openapi.json
git commit -m "spike(SPK-1): OpenCode 2.0.32 isolated server findings"
```

---

### Task 3: SPK-3, Job Object helper (Go)

**Files:**
- Create: `spikes/spk-3/helper/go.mod`, `spikes/spk-3/helper/main.go`
- Create: `spikes/spk-3/fixtures/tree.mjs`, `alloc.mjs`, `echo.mjs`, `parent.mjs`
- Create: `spikes/spk-3/run-experiments.mjs`
- Create: `docs/superpowers/spikes/SPK-3.md`

**Interfaces:**
- Produces: the prototype CLI `aiide-helper.exe run [--mem-mb N] [--max-procs N] [--parent-pid N] -- <exe> [args…]`.
  - Exit code is the child's, or **137** when the job memory limit was hit.
  - The helper terminates the whole job when the `--parent-pid` process exits.
  - Phase 2's EXE-2 productionizes this.

- [ ] **Step 1: USER ACTION. Install Go.**

Ask the user to approve: `winget install --id GoLang.Go -e --accept-source-agreements --accept-package-agreements`
After installing, open a new shell and run `go version`. Record the version in the report.

- [ ] **Step 2: Create the Go module**

Run:
```bash
cd spikes/spk-3/helper && go mod init aiide-helper-spike && go get golang.org/x/sys/windows@latest
```
Expected: `go.mod` and `go.sum` exist and reference `golang.org/x/sys`.

- [ ] **Step 3: Write the helper**

```go
// spikes/spk-3/helper/main.go — THROWAWAY spike: run a process tree inside a Windows Job Object.
package main

import (
	"flag"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const memoryLimitExitCode = 137

func fail(err error, what string) {
	fmt.Fprintf(os.Stderr, "aiide-helper: %s: %v\n", what, err)
	os.Exit(70)
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "run" {
		fmt.Fprintln(os.Stderr, "usage: aiide-helper run [--mem-mb N] [--max-procs N] [--parent-pid N] -- <exe> [args...]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	memMB := fs.Uint64("mem-mb", 0, "job memory limit in MB (0 = none)")
	maxProcs := fs.Uint("max-procs", 0, "active process limit (0 = none)")
	parentPID := fs.Uint("parent-pid", 0, "terminate the job when this process exits")
	_ = fs.Parse(os.Args[2:])
	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "aiide-helper: missing command after --")
		os.Exit(2)
	}
	os.Exit(run(fs.Args(), *memMB, uint32(*maxProcs), uint32(*parentPID)))
}

func run(argv []string, memMB uint64, maxProcs uint32, parentPID uint32) int {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		fail(err, "CreateJobObject")
	}
	defer windows.CloseHandle(job) // KILL_ON_JOB_CLOSE: closing the last handle kills every process in the job

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if memMB > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_JOB_MEMORY
		info.JobMemoryLimit = uintptr(memMB * 1024 * 1024)
	}
	if maxProcs > 0 {
		info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
		info.BasicLimitInformation.ActiveProcessLimit = maxProcs
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		fail(err, "SetInformationJobObject")
	}

	for _, h := range []windows.Handle{windows.Stdin, windows.Stdout, windows.Stderr} {
		_ = windows.SetHandleInformation(h, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT)
	}
	si := &windows.StartupInfo{
		Flags:     windows.STARTF_USESTDHANDLES,
		StdInput:  windows.Stdin,
		StdOutput: windows.Stdout,
		StdErr:    windows.Stderr,
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(argv))
	if err != nil {
		fail(err, "command line")
	}
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(nil, cmdLine, nil, nil, true,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT, nil, nil, si, &pi); err != nil {
		fail(err, "CreateProcess")
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		fail(err, "AssignProcessToJobObject")
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		fail(err, "ResumeThread")
	}

	handles := []windows.Handle{pi.Process}
	if parentPID != 0 {
		ph, err := windows.OpenProcess(windows.SYNCHRONIZE, false, parentPID)
		if err != nil {
			_ = windows.TerminateJobObject(job, 1)
			return 1
		}
		defer windows.CloseHandle(ph)
		handles = append(handles, ph)
	}
	ev, err := windows.WaitForMultipleObjects(handles, false, windows.INFINITE)
	if err != nil {
		fail(err, "WaitForMultipleObjects")
	}
	if ev == windows.WAIT_OBJECT_0+1 {
		_ = windows.TerminateJobObject(job, 1)
		return 1
	}
	var code uint32
	_ = windows.GetExitCodeProcess(pi.Process, &code)
	if memMB > 0 {
		var q windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		var n uint32
		if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&q)), uint32(unsafe.Sizeof(q)), &n); err == nil &&
			uint64(q.PeakJobMemoryUsed) >= memMB*1024*1024*98/100 {
			fmt.Fprintln(os.Stderr, "aiide-helper: job memory limit exceeded")
			return memoryLimitExitCode
		}
	}
	return int(code)
}
```

- [ ] **Step 4: Build it**

Run: `cd spikes/spk-3/helper && go build -o aiide-helper.exe .`
Expected: `aiide-helper.exe` builds with **no MSVC installed**. If the build fails, the compiler errors name the missing `x/sys/windows` symbol. Record it and adapt using the same API family (for example `windows.WaitForSingleObject` in a loop), noting the change in the report.

- [ ] **Step 5: Write the fixtures and experiment driver**

```js
// spikes/spk-3/fixtures/tree.mjs — spawns 2 long-lived grandchildren, writes their PIDs, then lives forever.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const pids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }).pid);
fs.writeFileSync(process.argv[2], JSON.stringify({ self: process.pid, grandchildren: pids }));
setInterval(() => {}, 1000);
```

```js
// spikes/spk-3/fixtures/alloc.mjs — allocates 50 MB every 50 ms until killed.
const hold = [];
setInterval(() => hold.push(Buffer.alloc(50e6, 1)), 50);
```

```js
// spikes/spk-3/fixtures/echo.mjs — echoes stdin to stdout, writes bytes 0..255 to stderr, exits with code 7.
process.stderr.write(Buffer.from([...Array(256).keys()]));
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => process.exit(7));
```

```js
// spikes/spk-3/fixtures/parent.mjs — stands in for the orchestrator: starts the helper with --parent-pid=self.
import { spawn } from 'node:child_process';
const [helper, pidFile] = process.argv.slice(2);
const child = spawn(helper, ['run', `--parent-pid=${process.pid}`, '--', process.execPath, new URL('./tree.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), pidFile], { stdio: 'inherit' });
console.log(JSON.stringify({ parent: process.pid, helper: child.pid }));
setInterval(() => {}, 1000);
```

```js
// spikes/spk-3/run-experiments.mjs — THROWAWAY driver. Prints a JSON result per experiment.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HERE = import.meta.dirname;
const HELPER = path.join(HERE, 'helper', 'aiide-helper.exe');
const FIX = (f) => path.join(HERE, 'fixtures', f);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk3-')), 'pids.json');
const waitFile = async (f) => { for (let i = 0; i < 100 && !fs.existsSync(f); i++) await sleep(100); return JSON.parse(fs.readFileSync(f, 'utf8')); };
const results = {};

// 1. taskkill /F on the helper (no /T) must kill grandchildren via KILL_ON_JOB_CLOSE
{
  const pidFile = tmp();
  const h = spawn(HELPER, ['run', '--', process.execPath, FIX('tree.mjs'), pidFile], { stdio: 'ignore' });
  const pids = await waitFile(pidFile);
  execFileSync('taskkill', ['/PID', String(h.pid), '/F']);
  await sleep(1500);
  results.killHelper = { childAlive: alive(pids.self), grandchildrenAlive: pids.grandchildren.map(alive) };
}
// 2. killing the "orchestrator" (parent) must make the helper end the job within 2 s
{
  const pidFile = tmp();
  const p = spawn(process.execPath, [FIX('parent.mjs'), HELPER, pidFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  const info = JSON.parse(await new Promise((r) => readline.createInterface({ input: p.stdout }).once('line', r)));
  const pids = await waitFile(pidFile);
  execFileSync('taskkill', ['/PID', String(info.parent), '/F']);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && (alive(info.helper) || pids.grandchildren.some(alive))) await sleep(100);
  results.killParent = { msUntilGone: Date.now() - t0, helperAlive: alive(info.helper), grandchildrenAlive: pids.grandchildren.map(alive) };
}
// 3. memory cap → exit code 137
{
  const h = spawn(HELPER, ['run', '--mem-mb=300', '--', process.execPath, FIX('alloc.mjs')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; h.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => h.once('exit', r));
  results.memoryCap = { exitCode: code, stderrTail: err.slice(-200) };
}
// 4. stdio relay byte-exact + exit code propagation
{
  const h = spawn(HELPER, ['run', '--', process.execPath, FIX('echo.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = []; const err = [];
  h.stdout.on('data', (d) => out.push(d)); h.stderr.on('data', (d) => err.push(d));
  const payload = Buffer.from('héllo\r\nwörld\0end', 'utf8');
  h.stdin.end(payload);
  const code = await new Promise((r) => h.once('exit', r));
  const stderrBytes = Buffer.concat(err);
  results.stdio = {
    exitCode: code,
    stdoutExact: Buffer.concat(out).equals(payload),
    stderrExact: stderrBytes.equals(Buffer.from([...Array(256).keys()])),
  };
}
// 5. process-count cap
{
  const h = spawn(HELPER, ['run', '--max-procs=2', '--', process.execPath, '-e',
    "const {spawnSync}=require('child_process');const r=[1,2,3].map(()=>spawnSync(process.execPath,['-e','0']).error?.code??'ok');console.log(JSON.stringify(r))"],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; h.stdout.on('data', (d) => (out += d));
  results.maxProcs = { exitCode: await new Promise((r) => h.once('exit', r)), output: out.trim() };
}
console.log(JSON.stringify(results, null, 2));
```

- [ ] **Step 6: Run the experiments**

Run: `node spikes/spk-3/run-experiments.mjs > spikes/spk-3/out.json; type spikes\spk-3\out.json`
Expected:
- `killHelper.childAlive=false` and `killHelper.grandchildrenAlive=[false,false]`.
- `killParent.helperAlive=false`, all grandchildren false, `msUntilGone` < 2000.
- `memoryCap.exitCode=137`.
- `stdio.exitCode=7`, `stdoutExact=true`, `stderrExact=true`.
- `maxProcs.output` shows that at least one spawn failed (the cap was enforced).

- [ ] **Step 7: Write the report**

Create `docs/superpowers/spikes/SPK-3.md` with the same structure as SPK-1's report:
- a Results table with one row per experiment, the observed values, `spikes/spk-3/out.json` as evidence, and the [V] marker;
- the Go version and `golang.org/x/sys` version from `go.mod`;
- this mandatory line: **"This is resource and lifecycle containment, not a security boundary"**;
- a Verdict section (GO/NO-GO for EXE-2) listing any API deviations from Step 4.

- [ ] **Step 8: Commit**

```bash
git add spikes/spk-3/helper/go.mod spikes/spk-3/helper/go.sum spikes/spk-3/helper/main.go spikes/spk-3/fixtures spikes/spk-3/run-experiments.mjs docs/superpowers/spikes/SPK-3.md
git commit -m "spike(SPK-3): Job Object helper prototype findings"
```

---

### Task 4: SPK-2, free-provider verification and probes

**Files:**
- Create: `spikes/spk-2/probe.mjs`
- Create: `spikes/spk-2/providers.v1.draft.json`
- Create: `docs/superpowers/spikes/SPK-2.md`

**Interfaces:**
- Consumes: `spikes/shared/mock-llm.mjs`, used to validate the probe itself first.
- Produces:
  - `node spikes/spk-2/probe.mjs --base-url=<url> --model=<id> [--key-env=<ENV_VAR_NAME>] [--ctx=32000] [--out=<file>]`, which writes a `ProbeResult` JSON: `{ toolCall: {pass, detail}, longContext: {pass, tokensSent, detail}, jsonSchema: {pass, detail}, throughput: {ttftMs, genTokensPerSec}, burst: {ok, statuses[]} }`.
  - A draft catalog file with the same field names as the spec's `providers` table.

- [ ] **Step 1: Write the probe**

```js
// spikes/spk-2/probe.mjs — THROWAWAY: OpenAI-compatible provider probes. Never prints the API key.
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));
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
```

- [ ] **Step 2: Validate the probe against the mock**

Run in two shells:
1. `node spikes/shared/mock-llm.mjs --port=18080 --scenario=spikes/spk-2/mock-scenario.json`
2. `node spikes/spk-2/probe.mjs --base-url=http://127.0.0.1:18080/v1 --model=mock-model --ctx=2000`

First create `spikes/spk-2/mock-scenario.json`:

```json
{ "turns": [
  { "tool_calls": [ { "name": "get_weather", "arguments": { "city": "Lisbon" } } ] },
  { "content": "It is 21 C in Lisbon." },
  { "content": "4417" },
  { "content": "```json\n{\"summary\":\"s\",\"subtasks\":[{\"id\":\"1\",\"description\":\"d\"}],\"complexity\":\"S\"}\n```" },
  { "content": "The printing press changed the world." } ],
  "fallback": { "content": "0" } }
```

Expected: `toolCall.pass`, `longContext.pass` and `jsonSchema.pass` are all `true`, and `burst.ok` is `true`.

- [ ] **Step 3: USER ACTION. Create accounts and keys.**

Ask the user to:
- Create (or confirm) accounts for **OpenCode Zen** (opencode.ai), **Ollama** (ollama.com, for Cloud Free), **Cloudflare** (Workers AI) and **OpenRouter**.
- For each, record whether a card or billing details were requested (this answers **Q-1**).
- Generate an API key for each, and set it **only in the current shell session**:

```powershell
$env:AIK_ZEN_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:AIK_OLLAMA_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:AIK_CF_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:AIK_OPENROUTER_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
```

`ConvertFrom-SecureString -AsPlainText` needs PowerShell 7. On Windows PowerShell 5.1, use `$env:AIK_ZEN_KEY = Read-Host` instead.

- [ ] **Step 4: Find each provider's OpenAI-compatible base URL and free model IDs**

For each provider, find the **current** OpenAI-compatible base URL and free model IDs in its official docs and record the source URL. Starting points to verify (not assumed correct):

| Provider | Candidate base URL |
|---|---|
| OpenCode Zen | `https://opencode.ai/zen/v1` |
| Ollama Cloud | the URL from ollama.com docs for API access (answers **Q-2**) |
| Cloudflare | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

Also read each provider's data-use/training terms page and record the URL and the exact sentence (answers **Q-3** for Cloudflare).

- [ ] **Step 5: Run the probes against each provider/model**

Example: `node spikes/spk-2/probe.mjs --base-url=https://opencode.ai/zen/v1 --model=<free model id> --key-env=AIK_ZEN_KEY --ctx=32000 --out=spikes/spk-2/out-zen-<model>.json`
Repeat for every default-eligible candidate: Zen GLM-5.3-Flash Free, Zen DeepSeek V4.1 Flash Free, Ollama Cloud Free models, Cloudflare glm-4.7-flash, and one OpenRouter `:free` model.
Expected: one JSON file per model. Failures are findings, not errors to fix.

- [ ] **Step 6: Interpret burst and limit results**

For each output, record `burst.statuses` and `burst.rateLimitHeaders`. Then estimate **stories/day** as `daily request limit ÷ 50` (about 50 model calls per story, per spec §9). Use the documented limit where one exists; otherwise use the observed limit and mark it [I].

- [ ] **Step 7 (optional, USER ACTION): Measure local throughput**

Only if the user consents to installing Ollama: `winget install --id Ollama.Ollama -e`.
1. Look up the exact current library tags for Qwen3.5-9B and Ornith-1.0-9B on ollama.com/library and record them.
2. Run `ollama pull <tag>`.
3. Create a 32k-context variant:

```
FROM <tag>
PARAMETER num_ctx 32768
```

   Save it as `spikes/spk-2/Modelfile.<name>`, then run `ollama create aik-<name>-32k -f spikes/spk-2/Modelfile.<name>`.
4. Probe it: `node spikes/spk-2/probe.mjs --base-url=http://127.0.0.1:11434/v1 --model=aik-<name>-32k --ctx=16000 --out=spikes/spk-2/out-local-<name>.json`

Record `throughput` and `longContext` timing. These replace the spec's [I] estimates in §10.2.

- [ ] **Step 8: Write the draft catalog**

Create `spikes/spk-2/providers.v1.draft.json`. Include one entry per verified provider/model and fill every field from the evidence:

```json
{
  "catalogVersion": 1,
  "termsCheckedAt": "<execution date>",
  "providers": [
    {
      "presetKey": "opencode-zen",
      "name": "OpenCode Zen",
      "kind": "openai_compatible",
      "baseUrl": "<verified base URL>",
      "costClass": "free_limited",
      "dataUse": "<no_training|may_train|unknown — per model, from terms>",
      "termsUrl": "<terms URL>",
      "cardRequired": "<true|false|unknown>",
      "models": [
        { "modelId": "<id>", "family": "<glm|deepseek|qwen|…>", "contextLimit": 0, "outputLimit": 0, "dataUse": "<…>", "probe": "<relative path to out-*.json>" }
      ]
    }
  ]
}
```

Replace every `<…>` and every `0` with verified values. If a value can't be verified, write `"unknown"` and explain it in the report.

- [ ] **Step 9: Write the report and verdict**

Create `docs/superpowers/spikes/SPK-2.md` with:
- a provider table: account, card, base URL, free models, documented limits, observed limits, data-use quote and URL, probe pass/fail ×4, estimated stories/day;
- answers to Q-1, Q-2 and Q-3;
- local throughput, if measured;
- **a verdict:**
  - If at least one **default-eligible** provider (data use `no_training`) passes the tool-call and JSON probes, the verdict is **GO**.
  - If none passes, write **ESCALATE**: stop and present the options to the user (revisit D-2 or D-5, or opt into a paid provider) before Phase 2.

- [ ] **Step 10: Clear the keys and commit**

Run in the same shell: `Remove-Item Env:AIK_ZEN_KEY, Env:AIK_OLLAMA_KEY, Env:AIK_CF_KEY, Env:AIK_OPENROUTER_KEY -ErrorAction SilentlyContinue`

```bash
git add spikes/spk-2/probe.mjs spikes/spk-2/mock-scenario.json spikes/spk-2/providers.v1.draft.json docs/superpowers/spikes/SPK-2.md
git commit -m "spike(SPK-2): free-provider verification and probe results"
```

Before committing, check that the probe outputs (`out-*.json`) aren't staged. They are covered by `.gitignore` only if they live under `out/`, so move them to `spikes/spk-2/out/` before committing.

---

### Task 5: SPK-4, GitHub App device flow and credential-helper push

**Files:**
- Create: `spikes/spk-4/package.json`
- Create: `spikes/spk-4/gh.mjs`, `device-flow.mjs`, `refresh.mjs`, `list-repos.mjs`, `cred-helper.mjs`, `push.mjs`, `merge-guard.mjs`
- Create: `docs/superpowers/spikes/SPK-4.md`

**Interfaces:**
- Produces:
  - Proof (or disproof) of device flow plus refresh without a client secret.
  - Credential-helper push with no token leakage.
  - Merge `sha`-guard behaviour.
  - Validation of the `@napi-rs/keyring` `Entry` API that GH-2 will use.

- [ ] **Step 1: USER ACTION. Register a scratch GitHub App and repo.**

Ask the user to do the following, and to tell you only the **client ID** and **repo owner/name**:
1. Create a **private** repo named `aik-spike-scratch` with a README (initial commit on `main`).
2. Open GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:
   - Name: `aik-spike-<user>`; Homepage URL: `https://github.com/<user>`.
   - Callback URL: leave empty.
   - **Enable Device Flow:** ✓.
   - **Expire user authorization tokens:** ✓ (default).
   - Webhook: **uncheck Active**.
   - Repository permissions: Metadata **Read**, Contents **Read and write**, Pull requests **Read and write**, Checks **Read**, Commit statuses **Read**. Nothing else.
   - Where can this app be installed: **Only on this account**.
3. Create the app, **don't** generate a client secret or private key, then install it on **only** `aik-spike-scratch`.

- [ ] **Step 2: Install the keyring dependency**

```json
// spikes/spk-4/package.json
{ "name": "aik-spk-4", "private": true, "type": "module", "dependencies": { "@napi-rs/keyring": "2.1.1" } }
```

Run: `npm install --prefix spikes/spk-4 --save-exact`

- [ ] **Step 3: Write the shared GitHub helpers**

```js
// spikes/spk-4/gh.mjs — THROWAWAY helpers. Tokens live only in Windows Credential Manager (service AiKanbanSpike).
import { Entry } from '@napi-rs/keyring';

export const API_VERSION = '2026-03-10';
export const clientId = () => { const c = process.env.AIK_SPIKE_GH_CLIENT_ID; if (!c) throw new Error('set AIK_SPIKE_GH_CLIENT_ID'); return c; };
const entry = () => new Entry('AiKanbanSpike', 'github');
export const saveTokens = (t) => entry().setPassword(JSON.stringify(t));
export const loadTokens = () => { const s = entry().getPassword(); if (!s) throw new Error('no tokens stored; run device-flow.mjs'); return JSON.parse(s); };
export const deleteTokens = () => entry().deletePassword();
export const mask = (s) => (s ? `${s.slice(0, 4)}…(${s.length})` : String(s));

export async function form(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { status: res.status, json: await res.json() };
}

export async function api(method, path, body) {
  const { access_token } = loadTokens();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${access_token}`, 'x-github-api-version': API_VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, rate: { remaining: res.headers.get('x-ratelimit-remaining'), reset: res.headers.get('x-ratelimit-reset') } };
}
```

- [ ] **Step 4: Write and run the device flow**

```js
// spikes/spk-4/device-flow.mjs — THROWAWAY
import { execFile } from 'node:child_process';
import { clientId, form, saveTokens, mask } from './gh.mjs';

const start = await form('https://github.com/login/device/code', { client_id: clientId() });
if (start.status !== 200) throw new Error(`device code request failed: ${JSON.stringify(start.json)}`);
const { device_code, user_code, verification_uri, interval, expires_in } = start.json;
console.log(`Enter code ${user_code} at ${verification_uri} (expires in ${expires_in}s)`);
execFile('cmd.exe', ['/c', 'start', '', verification_uri]);
let wait = interval;
const deadline = Date.now() + expires_in * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const r = await form('https://github.com/login/oauth/access_token', { client_id: clientId(), device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  const e = r.json.error;
  if (e === 'authorization_pending') continue;
  if (e === 'slow_down') { wait += 5; console.log(`slow_down → interval ${wait}s`); continue; }
  if (e) { console.log(`terminal error: ${e}`); process.exit(1); }
  saveTokens({ ...r.json, obtained_at: Date.now() });
  console.log(JSON.stringify({ token_type: r.json.token_type, expires_in: r.json.expires_in, refresh_token_expires_in: r.json.refresh_token_expires_in, access: mask(r.json.access_token), refresh: mask(r.json.refresh_token) }));
  process.exit(0);
}
console.log('expired_token (deadline passed)');
process.exit(1);
```

Run: `$env:AIK_SPIKE_GH_CLIENT_ID = "<client id from Step 1>"; node spikes/spk-4/device-flow.mjs`
The user enters the code in the browser.
Expected: the output shows `expires_in: 28800`, a `refresh_token_expires_in` of about 15897600, and masked tokens. No full token is printed.

- [ ] **Step 5: Refresh without a client secret, and list repos**

```js
// spikes/spk-4/refresh.mjs — THROWAWAY
import { clientId, form, loadTokens, saveTokens, mask } from './gh.mjs';
const old = loadTokens();
const r = await form('https://github.com/login/oauth/access_token', { client_id: clientId(), grant_type: 'refresh_token', refresh_token: old.refresh_token });
if (r.json.error) { console.log(`refresh failed: ${r.json.error} ${r.json.error_description ?? ''}`); process.exit(1); }
saveTokens({ ...r.json, obtained_at: Date.now() });
console.log(JSON.stringify({ refreshed: true, newAccess: mask(r.json.access_token), accessChanged: r.json.access_token !== old.access_token, refreshRotated: r.json.refresh_token !== old.refresh_token }));
```

```js
// spikes/spk-4/list-repos.mjs — THROWAWAY
import { api } from './gh.mjs';
const inst = await api('GET', '/user/installations');
const out = [];
for (const i of inst.json.installations ?? []) {
  const repos = await api('GET', `/user/installations/${i.id}/repositories?per_page=100`);
  for (const r of repos.json.repositories ?? []) out.push({ installation: i.id, full_name: r.full_name, private: r.private, default_branch: r.default_branch, permissions: r.permissions });
}
console.log(JSON.stringify({ installations: inst.status, repos: out, rate: inst.rate }, null, 2));
```

Run: `node spikes/spk-4/refresh.mjs`, then `node spikes/spk-4/list-repos.mjs`
Expected:
- `refreshed: true` with `accessChanged: true` and no secret used.
- The repo list contains `<user>/aik-spike-scratch` with `permissions.push: true`.

- [ ] **Step 6: Write the credential helper prototype**

```js
// spikes/spk-4/cred-helper.mjs — THROWAWAY git credential helper: token from parent over a named pipe with one-time nonce.
import net from 'node:net';
const op = process.argv[2];
if (op !== 'get') process.exit(0); // ignore store/erase
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const fields = Object.fromEntries(input.split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const sock = net.connect(process.env.AIK_SPIKE_CRED_PIPE, () => sock.end(JSON.stringify({ nonce: process.env.AIK_SPIKE_CRED_NONCE, host: fields.host })));
  let reply = '';
  sock.on('data', (d) => (reply += d));
  sock.on('end', () => {
    const r = JSON.parse(reply || '{}');
    if (r.password) process.stdout.write(`username=x-access-token\npassword=${r.password}\nquit=1\n`);
    process.exit(0);
  });
  sock.on('error', () => process.exit(0));
});
```

- [ ] **Step 7: Write and run the push with leak checks**

```js
// spikes/spk-4/push.mjs — THROWAWAY: clone scratch repo to temp, commit, push via helper; check for leaks.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadTokens } from './gh.mjs';

const repo = process.env.AIK_SPIKE_REPO; // "<owner>/aik-spike-scratch"
if (!repo?.endsWith('/aik-spike-scratch')) throw new Error('AIK_SPIKE_REPO must be <owner>/aik-spike-scratch');
const token = loadTokens().access_token;
const pipe = `\\\\.\\pipe\\aik-spike-cred-${crypto.randomBytes(8).toString('hex')}`;
const nonce = crypto.randomBytes(16).toString('hex');
let nonceUsed = false;
const server = net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => (buf += d));
  s.on('end', () => {
    const req = JSON.parse(buf || '{}');
    const ok = !nonceUsed && req.nonce === nonce && req.host === 'github.com';
    if (ok) nonceUsed = true;
    s.end(JSON.stringify(ok ? { password: token } : {}));
  });
}).listen(pipe);

const helperCmd = `!node "${path.join(import.meta.dirname, 'cred-helper.mjs').replaceAll('\\', '/')}"`;
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: helperCmd,
  AIK_SPIKE_CRED_PIPE: pipe, AIK_SPIKE_CRED_NONCE: nonce };

const cmdkeyBefore = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk4-'));
const git = (args, opts = {}) => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8', ...opts });
git(['clone', `https://github.com/${repo}.git`, '.']);
// Each git network operation needs a fresh nonce in the design; for the spike, re-arm between clone and push.
nonceUsed = false;
const branch = `spike/push-${Date.now()}`;
git(['checkout', '-b', branch]);
fs.writeFileSync(path.join(dir, `spike-${Date.now()}.txt`), 'spike\n');
git(['add', '.']);
git(['-c', 'user.name=aik-spike', '-c', 'user.email=aik-spike@localhost', 'commit', '-m', 'spike push']);

const push = spawn('git', ['push', '-u', 'origin', branch], { cwd: dir, env: gitEnv });
await new Promise((r) => setTimeout(r, 800));
const cmdlines = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'], { encoding: 'utf8' });
const pushCode = await new Promise((r) => push.once('exit', r));
const cmdkeyAfter = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' });
// Replay: the push consumed the nonce, so a second request with the same nonce must get no password.
const replayOut = execFileSync(process.execPath, [path.join(import.meta.dirname, 'cred-helper.mjs'), 'get'], { env: gitEnv, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
// Wrong host with a fresh nonce must also get nothing.
nonceUsed = false;
const wrongHostOut = execFileSync(process.execPath, [path.join(import.meta.dirname, 'cred-helper.mjs'), 'get'], { env: gitEnv, input: 'protocol=https\nhost=evil.example\n\n', encoding: 'utf8' });
server.close();

const gitConfig = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
console.log(JSON.stringify({
  pushExitCode: pushCode,
  branch,
  tokenInGitConfig: gitConfig.includes(token),
  tokenInAnyCommandLine: cmdlines.includes(token),
  newCredentialManagerEntries: cmdkeyAfter.split('\n').filter((l) => /github/i.test(l) && !cmdkeyBefore.includes(l.trim())),
  replayRejected: replayOut.trim() === '',
  wrongHostRejected: wrongHostOut.trim() === '',
}, null, 2));
fs.writeFileSync(path.join(import.meta.dirname, 'last-branch.txt'), branch);
```

Run: `$env:AIK_SPIKE_REPO = "<owner>/aik-spike-scratch"; node spikes/spk-4/push.mjs`
Expected:
- `pushExitCode: 0`.
- `tokenInGitConfig: false`.
- `tokenInAnyCommandLine: false`.
- `newCredentialManagerEntries: []` (Git Credential Manager didn't store the token).
- `replayRejected: true`.
- `wrongHostRejected: true`.

- [ ] **Step 8: Check behaviour when the orchestrator isn't running**

Run in the same shell:
```powershell
$env:AIK_SPIKE_CRED_PIPE = "\\.\pipe\does-not-exist"; $env:AIK_SPIKE_CRED_NONCE = "stale"
"protocol=https`nhost=github.com`n" | node spikes/spk-4/cred-helper.mjs get
```
Expected: no output (no credentials) and exit code 0. If no pipe is listening, git gets nothing and the helper doesn't hang. Record it.

- [ ] **Step 9: Write and run the merge sha-guard test**

```js
// spikes/spk-4/merge-guard.mjs — THROWAWAY: PR from the pushed branch; stale sha → 409; current sha → merged.
import fs from 'node:fs';
import path from 'node:path';
import { api } from './gh.mjs';

const repo = process.env.AIK_SPIKE_REPO;
if (!repo?.endsWith('/aik-spike-scratch')) throw new Error('AIK_SPIKE_REPO must be <owner>/aik-spike-scratch');
const branch = fs.readFileSync(path.join(import.meta.dirname, 'last-branch.txt'), 'utf8').trim();
const pr = await api('POST', `/repos/${repo}/pulls`, { title: `spike ${branch}`, head: branch, base: 'main', body: 'SPK-4 scratch PR' });
if (pr.status !== 201) throw new Error(`PR create failed ${pr.status}: ${JSON.stringify(pr.json)}`);
const headSha = pr.json.head.sha;
const stale = '0'.repeat(40);
const r1 = await api('PUT', `/repos/${repo}/pulls/${pr.json.number}/merge`, { sha: stale, merge_method: 'merge' });
const r2 = await api('PUT', `/repos/${repo}/pulls/${pr.json.number}/merge`, { sha: headSha, merge_method: 'merge' });
console.log(JSON.stringify({ pr: pr.json.number, staleShaStatus: r1.status, staleMessage: r1.json?.message, currentShaStatus: r2.status, merged: r2.json?.merged, mergeCommitSha: r2.json?.sha }, null, 2));
```

Run: `node spikes/spk-4/merge-guard.mjs`
Expected: `staleShaStatus: 409`, `currentShaStatus: 200`, `merged: true`.

- [ ] **Step 10: Clean up, report and commit**

Run: `node -e "import('./spikes/spk-4/gh.mjs').then(m=>m.deleteTokens())"`. This removes the spike tokens from Credential Manager.
Ask the user (USER ACTION) to revoke the spike app's authorization under GitHub Settings → Applications → Authorized GitHub Apps. They may keep or delete the scratch app and repo.

Create `docs/superpowers/spikes/SPK-4.md` with:
- a results table (device flow, refresh without a secret, installation listing, push leak checks, nonce single use, merge 409/200, keyring `Entry` API behaviour);
- any differences from spec §11–§14;
- a verdict (GO/NO-GO for GH-1…GH-9).

```bash
git add spikes/spk-4/package.json spikes/spk-4/package-lock.json spikes/spk-4/*.mjs docs/superpowers/spikes/SPK-4.md
git commit -m "spike(SPK-4): GitHub App device flow and credential-helper push findings"
```

---

### Task 6: Spec amendment pass

**Files:**
- Modify: `docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md` (only sections that a spike contradicted)

- [ ] **Step 1: Collect contradictions**

Read the four "Corrections needed" or "Verdict" sections. List each spec statement that a spike proved wrong or made concrete, for example:
- the real session-deletion operation;
- the shell config key;
- session-permission ordering;
- verified provider endpoints and limits;
- measured local tokens/s;
- `x/sys/windows` API deviations.

- [ ] **Step 2: Present the list to the user before editing**

Show the user the list, with each proposed replacement sentence and its evidence link. Edit only after they approve. Change [U]/[I] markers to [V] where a spike verified the fact, and update Q-1…Q-5 in §29.2 to "Resolved by SPK-n: …".

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-18-autonomous-ai-ide-design.md
git commit -m "docs(spec): amend with Phase 0 spike findings"
```
