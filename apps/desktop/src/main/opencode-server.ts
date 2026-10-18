// apps/desktop/src/main/opencode-server.ts — the app's own isolated OpenCode server (spec §18.3).
// Started lazily, shared for the app's lifetime, shut down by closing stdin (verified: exit 0).
// Isolation: XDG roots + a redirected HOME under <dataDir>\opencode, a per-start random password,
// project/claude/filewatcher integrations disabled — the user's personal OpenCode is never used.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  OpencodeChatResult,
  OpencodeLoginStartResult,
  OpencodeLoginWaitResult,
  OpencodeModelInfo,
  OpencodeModelsResult,
} from '@aik/contracts';
import { opencodeExePath } from './opencode.ts';

// ---- app settings (tiny JSON in the data dir; no secrets) ----

const DEFAULT_SETTINGS: AppSettings = { opencodeMode: 'managed' };

export function readAppSettings(dataDir: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as Partial<AppSettings>;
    return { opencodeMode: raw.opencodeMode === 'personal' ? 'personal' : 'managed' };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeAppSettings(dataDir: string, settings: AppSettings): AppSettings {
  const next: AppSettings = { opencodeMode: settings.opencodeMode === 'personal' ? 'personal' : 'managed' };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(next, null, 2));
  return next;
}

interface PersonalExe {
  exe: string;
  viaCmd: boolean;
}

/** Resolves the user's personal CLI (personal mode only; null when not installed). */
export function personalOpencodeExe(): PersonalExe | null {
  const candidates: PersonalExe[] = [];
  const globalNpm = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  candidates.push({ exe: globalNpm, viaCmd: false });
  try {
    const hits = execFileSync('where.exe', ['opencode'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const hit of hits) {
      if (/\.exe$/i.test(hit)) candidates.push({ exe: hit, viaCmd: false });
      else if (/\.(cmd|bat)$/i.test(hit)) candidates.push({ exe: hit, viaCmd: true });
    }
  } catch {
    // not on PATH
  }
  return candidates.find((c) => fs.existsSync(c.exe)) ?? null;
}

interface Server {
  proc: ChildProcess | null;
  url: string;
  auth: string;
  directory: string;
  api: (method: string, p: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
}

let server: Server | null = null;
let starting: Promise<Server | null> | null = null;

function gitBashPath(): string {
  const gitExe = (execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0] ?? '').trim();
  const gitRoot = path.dirname(path.dirname(gitExe));
  for (const candidate of [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(gitRoot, 'bin', 'bash.exe');
}

/** Minimal isolated config; the E2E mock provider is injected via AIK_OPENCODE_BASE_URL. */
function configContent(): Record<string, unknown> {
  const config: Record<string, unknown> = { snapshots: false };
  const mockUrl = process.env.AIK_OPENCODE_BASE_URL;
  if (mockUrl) {
    config.providers = {
      mock: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: mockUrl, apiKey: 'spike-not-a-secret' },
        models: { 'mock-model': { capabilities: { tools: true }, limit: { context: 131072, output: 8192 } } },
      },
    };
  }
  return config;
}

function createApiClient(url: string, auth: string, directory: string) {
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(new URL(p, url), {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', 'x-opencode-directory': directory },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
}

async function startServer(dataDir: string): Promise<Server | null> {
  const mode = readAppSettings(dataDir).opencodeMode;

  if (mode === 'personal') {
    // 1. If the user's OpenCode background service is already running (e.g. from their terminal CLI),
    // connect to it directly so the desktop app and terminal share the exact same sessions & state.
    const stateDir = process.env.XDG_STATE_HOME || path.join(process.env.USERPROFILE ?? '', '.local', 'state');
    const svcFile = path.join(stateDir, 'opencode', 'service.json');
    if (fs.existsSync(svcFile)) {
      try {
        const svc = JSON.parse(fs.readFileSync(svcFile, 'utf8')) as { url?: string; password?: string };
        if (svc.url && svc.password) {
          const auth = `Basic ${Buffer.from(`opencode:${svc.password}`).toString('base64')}`;
          const directory = process.cwd();
          const api = createApiClient(svc.url, auth, directory);
          const ping = await api('GET', '/api/session/active').catch(() => null);
          if (ping?.status === 200) {
            return { proc: null, url: svc.url, auth, directory, api };
          }
        }
      } catch {
        // service.json unreadable or server unreachable; fall through to spawning
      }
    }
  }

  let exe: string | null = null;
  let viaCmd = false;
  if (mode === 'personal') {
    const personal = personalOpencodeExe();
    if (personal) {
      exe = personal.exe;
      viaCmd = personal.viaCmd;
    }
  } else {
    exe = process.env.AIK_OPENCODE_EXE ? path.resolve(process.env.AIK_OPENCODE_EXE) : opencodeExePath(dataDir);
  }
  if (!exe || !fs.existsSync(exe)) return null;

  const root = path.join(dataDir, 'opencode');
  const oc = (d: string) => path.join(root, d);
  for (const d of ['data', 'config', 'state', 'cache', 'db', 'tmp', 'home', 'workspace']) fs.mkdirSync(oc(d), { recursive: true });
  const password = crypto.randomBytes(32).toString('base64url');
  // Common: per-start password and a neutralized git credential helper (no prompts, no helper access).
  const common: NodeJS.ProcessEnv = {
    OPENCODE_PASSWORD: password,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0',
  };
  let env: NodeJS.ProcessEnv;
  let directory = oc('workspace');
  if (mode === 'personal') {
    // Personal mode: user's personal CLI, config, login, providers and session database are shared
    // so the desktop app and the terminal CLI stay completely in sync.
    env = {
      ...process.env,
      ...common,
    };
    directory = process.cwd();
  } else {
    // Managed mode: full isolation — redirected HOME/XDG roots, integrations disabled (SPK-1 patterns).
    const home = oc('home');
    env = {
      ...process.env,
      ...common,
      TEMP: oc('tmp'), TMP: oc('tmp'),
      USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_DATA_HOME: oc('data'), XDG_CONFIG_HOME: oc('config'), XDG_STATE_HOME: oc('state'), XDG_CACHE_HOME: oc('cache'),
      OPENCODE_DB: path.join(oc('db'), 'opencode.db'),
      OPENCODE_CONFIG_DIR: oc('config'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent()),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
      OPENCODE_GIT_BASH_PATH: gitBashPath(),
    };
  }
  const proc = viaCmd
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" serve --stdio --port 0 --print-logs`], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(exe, ['serve', '--stdio', '--port', '0', '--print-logs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr?.on('data', () => undefined); // keep the pipe drained; logs stay out of the app log
  const first = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OpenCode server did not report a URL within 30 s')), 30_000);
    proc.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString().split(/\r?\n/)[0] ?? '');
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    proc.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('OpenCode server exited before becoming ready'));
    });
  });
  const url = (JSON.parse(first) as { url: string }).url;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const api = createApiClient(url, auth, directory);
  for (let i = 0; i < 150; i++) {
    const r = await api('GET', '/api/session/active').catch(() => ({ status: 0, body: null }));
    if (r.status === 200) break;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  return { proc, url, auth, directory, api };
}

function getServer(dataDir: string): Promise<Server | null> {
  if (server && (server.proc === null || server.proc.exitCode === null)) return Promise.resolve(server);
  starting ??= startServer(dataDir)
    .then((s) => {
      server = s;
      return s;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

export function stopOpencodeServer(): void {
  if (server) {
    if (server.proc) {
      const proc = server.proc;
      proc.stdin?.end(); // verified clean shutdown path on 2.0.32; older personal builds may assert/hang…
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill(); // …so always keep a hard-kill backstop
      }, 2_000).unref();
    }
    server = null;
  }
}

export async function listOpencodeModels(dataDir: string): Promise<OpencodeModelsResult> {
  try {
    const s = await getServer(dataDir);
    if (!s) return { ok: false, error: 'OpenCode is not installed (see Settings)' };
    const r = await s.api('GET', '/api/model');
    const body = r.body as { data?: unknown[] } | null;
    const models: OpencodeModelInfo[] = [];
    for (const m of body?.data ?? []) {
      const model = m as {
        providerID?: string; modelID?: string; id?: string; name?: string;
        enabled?: boolean; status?: string; limit?: { context?: number }; cost?: { input?: number; output?: number }[];
      };
      if (!model.providerID || model.enabled === false || model.status === 'deprecated') continue;
      const first = model.cost?.[0];
      models.push({
        providerID: model.providerID,
        id: model.modelID ?? model.id ?? '',
        name: model.name ?? model.modelID ?? model.id ?? '',
        contextLimit: model.limit?.context ?? null,
        free: (first?.input ?? 1) === 0 && (first?.output ?? 1) === 0,
      });
    }
    if (models.length === 0) return { ok: false, error: 'The OpenCode server reported no models' };
    models.sort((a, b) => {
      // Prioritize configured / custom providers before the built-in free gateway models
      const aIsGateway = a.providerID === 'opencode';
      const bIsGateway = b.providerID === 'opencode';
      if (aIsGateway !== bIsGateway) return aIsGateway ? 1 : -1;
      return a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id);
    });
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface OpencodeMessage {
  type?: string;
  outcome?: string;
  finish?: string;
  content?: { type?: string; text?: string }[];
  error?: { message?: string };
}

/** One-shot chat against the chosen model; used by Settings' model test. */
export async function opencodeChat(dataDir: string, model: { providerID: string; id: string }, prompt: string): Promise<OpencodeChatResult> {
  try {
    const s = await getServer(dataDir);
    if (!s) return { ok: false, error: 'OpenCode is not installed (see Settings)' };
    const id = `ses_aik${crypto.randomBytes(8).toString('hex')}`;
    const created = await s.api('POST', '/api/session', {
      id,
      title: 'Model test',
      location: { directory: s.directory },
      model: { id: model.id, providerID: model.providerID },
    });
    if (created.status !== 200) return { ok: false, error: `The model refused the session (${created.status})` };
    await s.api('POST', `/api/session/${id}/prompt`, { text: prompt });
    // Wait for the session to fall idle (SPK-1 pattern), then read the last assistant text.
    const deadline = Date.now() + 180_000;
    for (;;) {
      const active = await s.api('GET', '/api/session/active').catch(() => ({ status: 0, body: null }));
      if (!JSON.stringify(active.body).includes(id)) break;
      if (Date.now() > deadline) {
        void s.api('DELETE', `/api/session/${id}`);
        return { ok: false, error: 'The model did not finish within 3 minutes' };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const messages = await s.api('GET', `/api/session/${id}/message`);
    const data = (messages.body as { data?: OpencodeMessage[] } | null)?.data ?? [];
    void s.api('DELETE', `/api/session/${id}`);
    // Surface provider/auth failures instead of a misleading "no text" (observed with the
    // gateway's FreeTierError when the user has not signed in yet).
    const failure = data.find((m) => m.type === 'idle' && m.outcome === 'failed') ?? data.find((m) => m.finish === 'error');
    if (failure?.error?.message) return { ok: false, error: failure.error.message };
    const assistant = [...data].reverse().find((m) => m.type === 'assistant');
    const text = (assistant?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim();
    if (!text) return { ok: false, error: 'The model returned no text' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True once an OpenCode Console account is connected (credentials live in the isolated data dir). */
export async function opencodeSignedIn(dataDir: string): Promise<boolean> {
  try {
    const s = await getServer(dataDir);
    if (!s) return false;
    const r = await s.api('GET', '/api/integration/opencode');
    const connections = (r.body as { data?: { connections?: unknown[] } } | null)?.data?.connections ?? [];
    return connections.length > 0;
  } catch {
    return false;
  }
}

let loginAttempt: { attemptID: string; expires: number } | null = null;

/** Starts the device-style sign-in (opens the browser) and returns the URL plus the code to enter. */
export async function opencodeLoginStart(dataDir: string): Promise<OpencodeLoginStartResult> {
  try {
    const s = await getServer(dataDir);
    if (!s) return { ok: false, error: 'OpenCode is not installed (see Settings)' };
    const r = await s.api('POST', '/api/integration/opencode/connect/oauth', { methodID: 'device' });
    const attempt = (r.body as { data?: { attemptID?: string; url?: string; instructions?: string; time?: { expires?: number } } } | null)?.data;
    if (r.status !== 200 || !attempt?.attemptID || !attempt.url) {
      return { ok: false, error: `Sign-in could not be started (${r.status})` };
    }
    loginAttempt = { attemptID: attempt.attemptID, expires: attempt.time?.expires ?? Date.now() + 600_000 };
    return { ok: true, url: attempt.url, code: attempt.instructions ?? attempt.url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Waits (up to 9 minutes) for the sign-in started by opencodeLoginStart to complete in the browser. */
export async function opencodeLoginWait(dataDir: string): Promise<OpencodeLoginWaitResult> {
  try {
    const s = await getServer(dataDir);
    if (!s || !loginAttempt) return { ok: false, error: 'No sign-in was started' };
    const { attemptID } = loginAttempt;
    while (Date.now() < loginAttempt.expires - 30_000) {
      const r = await s.api('GET', `/api/integration/opencode/connect/oauth/${attemptID}`).catch(() => ({ status: 0, body: null }));
      const status = (r.body as { data?: { status?: string } } | null)?.data?.status;
      if (status === 'complete') {
        loginAttempt = null;
        return { ok: true };
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }
    loginAttempt = null;
    return { ok: false, error: 'Sign-in timed out — try again' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
