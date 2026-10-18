// apps/desktop/scripts/dev.mjs — Vite dev server + shell build + Electron pointed at the dev server.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shellBuild = spawnSync(process.execPath, [path.join(root, 'apps/desktop/scripts/build.mjs'), '--no-ui'], { stdio: 'inherit' });
if (shellBuild.status !== 0) process.exit(shellBuild.status ?? 1);
const vite = spawn(npx, ['vite', '--port', '5173', '--strictPort'], { cwd: path.join(root, 'apps/ui'), stdio: 'inherit', shell: true });
const electron = spawn(npx, ['electron', path.join(root, 'apps/desktop/dist')], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, AIK_UI_DEV_URL: 'http://localhost:5173/' },
});
electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
