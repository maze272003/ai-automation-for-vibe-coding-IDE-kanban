import type { BridgeResponse, SystemState } from '@aik/contracts';
import { listBackups, restoreBackup } from '@aik/db/backup';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { installOpencode, opencodeStatus } from './opencode.ts';
import { listOpencodeModels, opencodeChat, opencodeLoginStart, opencodeLoginWait, opencodeSignedIn, readAppSettings, writeAppSettings } from './opencode-server.ts';
import { stopOpencodeServer } from './opencode-server.ts';
import type { DesktopPaths } from './paths.ts';
import type { OrchestratorSupervisor } from './supervisor.ts';

const BridgeRequest = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().max(2000).regex(/^\/(?!events\b)[A-Za-z0-9/_\-.~%?=&,+:@()]*$/),
  body: z.unknown().optional(),
  idempotencyKey: z.uuid().optional(),
});

export interface BridgeDeps {
  supervisor: OrchestratorSupervisor;
  token: string;
  paths: DesktopPaths;
  opencodeAssetsDir: string;
  isTrustedSender: (url: string) => boolean;
}

const unavailable = (message: string): BridgeResponse => ({
  status: 503,
  body: { error: { code: 'DEPENDENCY_UNAVAILABLE', message, retryable: true } },
});

function assertTrusted(event: IpcMainInvokeEvent, deps: BridgeDeps): void {
  const url = event.senderFrame?.url ?? '';
  if (!deps.isTrustedSender(url)) throw new Error('Untrusted IPC sender');
}

/** The renderer's only door to the orchestrator. The token never leaves the main process (plan deviation 1). */
export function registerBridge(deps: BridgeDeps): void {
  ipcMain.handle('aik:request', async (event, raw: unknown): Promise<BridgeResponse> => {
    assertTrusted(event, deps);
    const req = BridgeRequest.parse(raw);
    const port = deps.supervisor.port;
    if (port === null) return unavailable('The orchestrator is not running');
    try {
      const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${deps.token}`,
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(req.idempotencyKey ? { 'idempotency-key': req.idempotencyKey } : {}),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    } catch {
      return unavailable('The orchestrator did not respond');
    }
  });

  ipcMain.handle('aik:pick-directory', async (event): Promise<string | null> => {
    assertTrusted(event, deps);
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('aik:system-state', (event): SystemState => {
    assertTrusted(event, deps);
    return { state: deps.supervisor.state, fatal: deps.supervisor.fatal };
  });

  ipcMain.handle('aik:restore-latest-backup', (event) => {
    assertTrusted(event, deps);
    if (deps.supervisor.state !== 'fatal' || deps.supervisor.fatal?.kind !== 'database_corrupt') {
      return { ok: false as const, reason: 'Restore is only available when the database is corrupt' };
    }
    const latest = listBackups(deps.paths.backups).at(-1);
    if (!latest) return { ok: false as const, reason: 'No backups were found' };
    restoreBackup(latest, deps.paths.db);
    deps.supervisor.restart();
    return { ok: true as const, restoredFrom: path.basename(latest) };
  });

  ipcMain.handle('aik:opencode-status', (event) => {
    assertTrusted(event, deps);
    return opencodeStatus(deps.paths.dataDir);
  });

  ipcMain.handle('aik:opencode-install', async (event) => {
    assertTrusted(event, deps);
    return installOpencode(deps.paths.dataDir, deps.opencodeAssetsDir);
  });

  ipcMain.handle('aik:opencode-models', async (event) => {
    assertTrusted(event, deps);
    return listOpencodeModels(deps.paths.dataDir);
  });

  ipcMain.handle('aik:opencode-signed-in', async (event) => {
    assertTrusted(event, deps);
    return opencodeSignedIn(deps.paths.dataDir);
  });

  ipcMain.handle('aik:opencode-login-start', async (event) => {
    assertTrusted(event, deps);
    const result = await opencodeLoginStart(deps.paths.dataDir);
    if (result.ok) await shell.openExternal(result.url); // the only sanctioned external navigation
    return result;
  });

  ipcMain.handle('aik:opencode-login-wait', async (event) => {
    assertTrusted(event, deps);
    return opencodeLoginWait(deps.paths.dataDir);
  });

  ipcMain.handle('aik:app-settings', (event) => {
    assertTrusted(event, deps);
    return readAppSettings(deps.paths.dataDir);
  });

  ipcMain.handle('aik:app-settings-set', (event, raw: unknown) => {
    assertTrusted(event, deps);
    const parsed = z.object({ opencodeMode: z.enum(['managed', 'personal']) }).parse(raw);
    stopOpencodeServer(); // the next call starts a server in the new mode
    return writeAppSettings(deps.paths.dataDir, parsed);
  });

  ipcMain.handle('aik:opencode-chat', async (event, raw: unknown) => {
    assertTrusted(event, deps);
    const req = z
      .object({ providerID: z.string().min(1).max(100), id: z.string().min(1).max(200), prompt: z.string().min(1).max(20_000) })
      .parse(raw);
    return opencodeChat(deps.paths.dataDir, { providerID: req.providerID, id: req.id }, req.prompt);
  });

  ipcMain.handle('aik:restart-orchestrator', (event) => {
    assertTrusted(event, deps);
    deps.supervisor.restart();
  });

  ipcMain.handle('aik:open-terminal-cli', async (event, raw: unknown) => {
    assertTrusted(event, deps);
    const parsed = z
      .object({
        sessionId: z.string().optional(),
        cwd: z.string().optional(),
      })
      .optional()
      .safeParse(raw);
    const sessionId = parsed.success ? parsed.data?.sessionId : undefined;
    const cwd = parsed.success && parsed.data?.cwd ? parsed.data.cwd : process.cwd();

    try {
      if (process.platform === 'win32') {
        const args = ['/c', 'start', 'cmd.exe', '/k', 'opencode'];
        if (sessionId) {
          args.push('--session', sessionId);
        }
        spawn('cmd.exe', args, {
          cwd,
          detached: true,
          stdio: 'ignore',
          shell: true,
        }).unref();
      } else {
        const cmd = sessionId ? `opencode --session ${sessionId}` : 'opencode';
        spawn('sh', ['-c', cmd], {
          cwd,
          detached: true,
          stdio: 'ignore',
        }).unref();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
