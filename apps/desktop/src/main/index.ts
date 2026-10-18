import { app, protocol, session, utilityProcess, type BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerBridge } from './bridge.ts';
import { EventForwarder } from './events-forwarder.ts';
import { stopOpencodeServer } from './opencode-server.ts';
import { desktopPaths, resolveDataDir } from './paths.ts';
import { APP_SCHEME, registerAppProtocol } from './protocol.ts';
import { OrchestratorSupervisor, type ChildLike } from './supervisor.ts';
import { createMainWindow } from './window.ts';

protocol.registerSchemesAsPrivileged([APP_SCHEME]);

const isE2E = process.env.AIK_E2E === '1';
const paths = desktopPaths(resolveDataDir(process.env, app.getPath('appData')));
fs.mkdirSync(paths.logs, { recursive: true });
app.setPath('userData', paths.electronUserData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function forkOrchestrator(): ChildLike {
  const proc = utilityProcess.fork(path.join(__dirname, 'orchestrator.cjs'), [], { serviceName: 'AI Kanban Orchestrator', stdio: 'pipe' });
  const out = fs.createWriteStream(path.join(paths.logs, 'orchestrator-stdio.log'), { flags: 'a' });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  const child: ChildLike = {
    get pid() {
      return proc.pid;
    },
    postMessage: (m: unknown) => proc.postMessage(m),
    kill: () => proc.kill(),
    on(event: 'message' | 'exit', listener: (arg: never) => void) {
      proc.on(event as 'exit', listener as (code: number) => void);
      return child;
    },
  };
  return child;
}

function main(): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const devUrl = process.env.AIK_UI_DEV_URL ?? null;
  let win: BrowserWindow | null = null;

  const supervisor = new OrchestratorSupervisor({
    fork: forkOrchestrator,
    initMessage: () => ({
      type: 'init',
      token,
      dataDir: paths.dataDir,
      migrationsFolder: path.join(__dirname, 'migrations'),
      versions: { app: app.getVersion(), electron: process.versions.electron },
      logLevel: process.env.AIK_LOG_LEVEL ?? 'info',
    }),
    schedule: isE2E && process.env.AIK_TEST_FAST_RESTART === '1' ? [50, 50, 50, 50, 50] : undefined,
  });
  const forwarder = new EventForwarder({ getPort: () => supervisor.port, token, send: (e) => win?.webContents.send('aik:event', e) });
  supervisor.on('state', () => win?.webContents.send('aik:system', { state: supervisor.state, fatal: supervisor.fatal }));

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    forwarder.stop();
    stopOpencodeServer();
    void supervisor.stop().finally(() => app.quit());
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerAppProtocol(path.join(__dirname, 'ui'));
    registerBridge({
      supervisor,
      token,
      paths,
      opencodeAssetsDir: path.join(__dirname, 'opencode-runtime'),
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
    });
    supervisor.start();
    forwarder.start();
    win = createMainWindow({ preload: path.join(__dirname, 'preload.cjs'), url: devUrl ?? 'app://ui/index.html' });
    if (isE2E) (globalThis as Record<string, unknown>).__aik = { supervisor, dataDir: paths.dataDir, token };
  });
}
