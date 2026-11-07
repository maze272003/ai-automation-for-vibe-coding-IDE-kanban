// apps/desktop/src/main/terminal-ipc.ts — guarded `aik:terminal-*` invoke handlers
// (Phase 5.3 spec §Component design 3). Uses a silent untrusted-sender
// guard (spec T-12) but on `ipcMain.handle`, because the preload calls `invoke`:
// every refusal is RETURNED as the resolved value (the silent error shape), never
// thrown. Thin by design — the manager is unit-tested, this path is e2e-covered.
import {
  TerminalClosePayload,
  TerminalOpenPayload,
  TerminalResizePayload,
  TerminalWritePayload,
  type TerminalOpenResult,
} from '@aik/contracts';
import { ipcMain } from 'electron';
import type { TerminalManager } from './terminal.ts';

export interface TerminalIpcDeps {
  manager: TerminalManager;
  isTrustedSender: (url: string) => boolean;
}

/** Silent `open` refusal (untrusted sender, malformed payload, unexpected error). */
const openRefusal: TerminalOpenResult = { ok: false, reason: 'BAD_REQUEST' };

export function registerTerminalIpc(deps: TerminalIpcDeps): void {
  ipcMain.handle('aik:terminal-open', async (event, raw: unknown): Promise<TerminalOpenResult> => {
    try {
      if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return openRefusal;
      const payload = TerminalOpenPayload.safeParse(raw);
      if (!payload.success) return openRefusal;
      // event.sender (the calling renderer's webContents) is the session owner whose
      // lifetime events kill the session on reload/crash/destroy (spec T-10).
      return await deps.manager.open(payload.data, event.sender);
    } catch {
      return openRefusal; // handlers never throw (spec T-12)
    }
  });

  ipcMain.handle('aik:terminal-write', (event, raw: unknown): boolean => {
    try {
      if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return false;
      const payload = TerminalWritePayload.safeParse(raw);
      if (!payload.success) return false;
      return deps.manager.write(payload.data.id, payload.data.data);
    } catch {
      return false;
    }
  });

  ipcMain.handle('aik:terminal-resize', (event, raw: unknown): boolean => {
    try {
      if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return false;
      const payload = TerminalResizePayload.safeParse(raw);
      if (!payload.success) return false;
      return deps.manager.resize(payload.data.id, payload.data.cols, payload.data.rows);
    } catch {
      return false;
    }
  });

  ipcMain.handle('aik:terminal-close', (event, raw: unknown): boolean => {
    try {
      if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return false;
      const payload = TerminalClosePayload.safeParse(raw);
      if (!payload.success) return false;
      return deps.manager.close(payload.data.id);
    } catch {
      return false;
    }
  });
}
