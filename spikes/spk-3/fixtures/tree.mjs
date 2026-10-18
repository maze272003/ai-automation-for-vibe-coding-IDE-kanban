// spikes/spk-3/fixtures/tree.mjs — spawns 2 long-lived grandchildren, writes their PIDs, then lives forever.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const pids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }).pid);
fs.writeFileSync(process.argv[2], JSON.stringify({ self: process.pid, grandchildren: pids }));
setInterval(() => {}, 1000);
