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
