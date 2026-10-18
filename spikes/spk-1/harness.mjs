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
  const gitRoot = path.dirname(path.dirname(gitExe));
  const candidate1 = path.join(gitRoot, 'bin', 'bash.exe');
  if (fs.existsSync(candidate1)) return candidate1;
  const candidate2 = path.join(gitRoot, 'usr', 'bin', 'bash.exe');
  if (fs.existsSync(candidate2)) return candidate2;
  return candidate1;
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
  const created = await server.api('POST', '/api/session', { id, location: { directory: sb.work }, agent, model: { id: 'mock-model', providerID: 'mock' }, title: `spk1 ${agent}` });
  save(`session-create-${agent}.json`, created);
  const prompted = await server.api('POST', `/api/session/${id}/prompt`, { text: prompt });
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
    await server.api('POST', '/api/session', { id, location: { directory: sb.work }, agent: 'aik-implementer', model: { id: 'mock-model', providerID: 'mock' } });
    await server.api('POST', `/api/session/${id}/prompt`, { text: 'go' });
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
  // h: per-session permissions passed on create — additive or overriding?
  async h() {
    const sb = makeSandbox();
    const before = sha256(path.join(sb.work, 'target.txt'));
    const mock = await startMock(path.join(HERE, 'scenarios', 'reviewer-edit.json'), path.join(OUT, 'recorded-h'));
    const server = await startServer(sb, mock.url);
    const id = `ses_spk1${crypto.randomBytes(6).toString('hex')}`;
    const created = await server.api('POST', '/api/session', {
      id, location: { directory: sb.work }, agent: 'aik-reviewer', model: { id: 'mock-model', providerID: 'mock' },
      permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
    });
    await server.api('POST', `/api/session/${id}/prompt`, { text: 'Review' });
    await waitIdle(server.api, id, 60000);
    save('session-permissions.json', { createStatus: created.status, sessionAllowEditOverrodeAgentDeny: sha256(path.join(sb.work, 'target.txt')) !== before });
    server.proc.stdin.end(); mock.proc.kill();
  },
};

const name = process.argv[2];
if (!experiments[name]) { console.error(`usage: node harness.mjs <${Object.keys(experiments).join('|')}>`); process.exit(2); }
await experiments[name]();
