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
