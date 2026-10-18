// spikes/spk-3/fixtures/parent.mjs — stands in for the orchestrator: starts the helper with --parent-pid=self.
import { spawn } from 'node:child_process';
const [helper, pidFile] = process.argv.slice(2);
const child = spawn(helper, ['run', `--parent-pid=${process.pid}`, '--', process.execPath, new URL('./tree.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), pidFile], { stdio: 'inherit' });
console.log(JSON.stringify({ parent: process.pid, helper: child.pid }));
setInterval(() => {}, 1000);
