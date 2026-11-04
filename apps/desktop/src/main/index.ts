import { app, protocol, session, utilityProcess, type BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerBridge } from './bridge.ts';
import { EventForwarder } from './events-forwarder.ts';
import { refreshGatewayContext, setGatewayContext } from './gateway-context.ts';
import { getOfficeContext, setOfficeContext } from './office-context.ts';
import { readAppSettings, stopOpencodeServer } from './opencode-server.ts';
import { installPixelAgents, officeInstalled, startOfficeServer, stopOfficeServer } from './office-server.ts';
import { OfficeViewManager, registerOfficeIpc } from './office-view.ts';
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
  // The model gateway (spec PK-2) is managed-mode only: a random per-run token kept in this
  // function's memory (and in the gateway context for the OpenCode config), never logged or
  // persisted. Personal mode passes nothing — the orchestrator then starts no gateway and
  // registers no provider routes, so personal wiring stays byte-identical.
  const managed = readAppSettings(paths.dataDir).opencodeMode === 'managed';
  const gatewayToken = managed ? crypto.randomBytes(32).toString('base64url') : null;
  if (gatewayToken) setGatewayContext({ token: gatewayToken });
  const devUrl = process.env.AIK_UI_DEV_URL ?? null;
  let win: BrowserWindow | null = null;

  const supervisor = new OrchestratorSupervisor({
    fork: forkOrchestrator,
    initMessage: () => ({
      type: 'init',
      token,
      ...(gatewayToken ? { gatewayToken } : {}),
      ...(getOfficeContext() ? { agentOffice: getOfficeContext() } : {}),
      dataDir: paths.dataDir,
      migrationsFolder: path.join(__dirname, 'migrations'),
      versions: { app: app.getVersion(), electron: process.versions.electron },
      logLevel: process.env.AIK_LOG_LEVEL ?? 'info',
    }),
    schedule: isE2E && process.env.AIK_TEST_FAST_RESTART === '1' ? [50, 50, 50, 50, 50] : undefined,
  });
  const sendToWindow = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };

  const forwarder = new EventForwarder({ getPort: () => supervisor.port, token, send: (e) => sendToWindow('aik:event', e) });
  supervisor.on('state', () => sendToWindow('aik:system', { state: supervisor.state, fatal: supervisor.fatal }));
  supervisor.on('ready', (port: number, gatewayPort: number | null) => {
    // Publish the connected providers + gateway base URL into the main-process context so the
    // next lazy OpenCode boot (and every provider connect/remove restart) sees fresh fragments.
    void refreshGatewayContext({ port, apiToken: token, gatewayPort });
  });

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
    stopOfficeServer();
    void supervisor.stop().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerAppProtocol(path.join(__dirname, 'ui'));

    // Pixel Agents office (spec 2026-11-04): boot before the supervisor so the init message
    // carries the config; failures degrade to feature-off (no office, no bridge).
    if (readAppSettings(paths.dataDir).agentOffice) {
      if (!officeInstalled(paths.dataDir)) {
        const installed = installPixelAgents(paths.dataDir, path.join(__dirname, 'pixel-agents-runtime'));
        if (!installed.ok) console.error(`agent office install failed: ${installed.error}`);
      }
      if (officeInstalled(paths.dataDir)) {
        const info = await startOfficeServer({ dataDir: paths.dataDir, assetsDir: path.join(__dirname, 'pixel-agents-runtime') });
        if (info) setOfficeContext({ url: info.url, token: info.token });
      }
    }

    registerBridge({
      supervisor,
      token,
      paths,
      opencodeAssetsDir: path.join(__dirname, 'opencode-runtime'),
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
      onSettingsChanged: async (next) => {
        if (next.agentOffice) {
          if (!officeInstalled(paths.dataDir)) {
            const installed = installPixelAgents(paths.dataDir, path.join(__dirname, 'pixel-agents-runtime'));
            if (!installed.ok) console.error(`agent office install failed: ${installed.error}`);
          }
          const info = officeInstalled(paths.dataDir)
            ? await startOfficeServer({ dataDir: paths.dataDir, assetsDir: path.join(__dirname, 'pixel-agents-runtime') })
            : null;
          if (info) setOfficeContext({ url: info.url, token: info.token });
        } else {
          stopOfficeServer();
          setOfficeContext(null);
        }
        // initMessage is a closure: the restarted orchestrator gets the new office state.
        supervisor.restart();
      },
    });
    supervisor.start();
    forwarder.start();
    win = createMainWindow({ preload: path.join(__dirname, 'preload.cjs'), url: devUrl ?? 'app://ui/index.html' });
    win.on('closed', () => {
      win = null;
    });
    const officeManager = new OfficeViewManager(win);
    registerOfficeIpc({
      manager: officeManager,
      isTrustedSender: (url) => url.startsWith('app://ui/') || (devUrl !== null && url.startsWith(devUrl)),
    });
    win.on('closed', () => officeManager.destroy());
    if (isE2E) (globalThis as Record<string, unknown>).__aik = { supervisor, dataDir: paths.dataDir, token };
  });
}
