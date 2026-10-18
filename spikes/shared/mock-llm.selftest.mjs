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
