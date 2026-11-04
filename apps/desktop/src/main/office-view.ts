// apps/desktop/src/main/office-view.ts — embeds the office web UI tokenless (read-only,
// enforced server-side by pixel-agents) in a WebContentsView layered over the renderer's
// /office route. An <iframe> is not viable in production: app:// is a secure scheme and an
// http subframe would be blocked as mixed content (spec 2026-11-04).
import type { OfficeBounds } from '@aik/contracts';
import { ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import { applyOfficeFrame, officeClickLabel } from './office-click-frames.ts';
import { getOfficeContext, parseOfficeBounds } from './office-context.ts';

export class OfficeViewManager {
  private view: WebContentsView | null = null;
  /** Origin the current view loaded; a server restart picks a new ephemeral port. */
  private loadedOrigin: string | null = null;
  private visible = false;
  private bounds: OfficeBounds | null = null;
  /** id → directoryName learned from the office page's WebSocket broadcasts (CDP click observer). */
  private readonly labels = new Map<number, string>();

  constructor(private readonly win: BrowserWindow) {}

  private ensureView(): WebContentsView | null {
    const office = getOfficeContext();
    if (!office || this.win.isDestroyed()) return null;
    const origin = `${office.url}/`;
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
      });
      this.view.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origin)) event.preventDefault();
      });
      this.win.contentView.addChildView(this.view);
      void this.view.webContents.loadURL(origin);
      this.loadedOrigin = origin;
      void this.attachClickObserver();
    } else if (this.loadedOrigin !== origin) {
      // The office server was restarted (e.g. the feature toggled off then on) and its
      // new instance has a new ephemeral port: reload the existing view to the live
      // origin instead of leaving it on a dead one.
      this.labels.clear(); // agent ids are per server instance; relearn from the new broadcasts
      void this.view.webContents.loadURL(origin);
      this.loadedOrigin = origin;
    }
    return this.view;
  }

  show(): void {
    this.visible = true;
    const view = this.ensureView();
    if (view && this.bounds && this.bounds.width > 0 && this.bounds.height > 0) view.setBounds(this.bounds);
  }

  hide(): void {
    this.visible = false;
    this.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  setBounds(bounds: OfficeBounds): void {
    this.bounds = bounds;
    if (this.visible && this.view && bounds.width > 0 && bounds.height > 0) this.view.setBounds(bounds);
  }

  destroy(): void {
    if (!this.view) return;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    try {
      this.view.webContents.debugger.detach();
    } catch {
      // not attached — nothing to clean up
    }
    this.view.webContents.close();
    this.view = null;
    this.loadedOrigin = null;
  }

  private clickHandler: ((label: string) => void) | null = null;

  /** The window forwards office click IPC here; only the office view's own webContents may use it. */
  acceptAgentClick(senderWebContentsId: number, label: unknown): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (senderWebContentsId !== this.view.webContents.id) return; // exact match, no URL heuristics
    if (typeof label !== 'string' || label === '' || label.length > 200) return;
    this.clickHandler?.(label);
  }

  /** Register the UI-side click consumer (label = `${storyKey} ${role}`). */
  onClick(handler: (label: string) => void): void {
    this.clickHandler = handler;
  }

  /** Passively observe the office page's WebSocket frames via CDP (no code enters their page). */
  private async attachClickObserver(): Promise<void> {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    try {
      view.webContents.debugger.attach('1.3');
      await view.webContents.debugger.sendCommand('Network.enable');
      view.webContents.debugger.on('message', (_event, method, params) => {
        const payload = (params as { response?: { payloadData?: unknown } } | undefined)?.response?.payloadData;
        if (payload === undefined) return;
        if (method === 'Network.webSocketFrameReceived') applyOfficeFrame(this.labels, payload);
        else if (method === 'Network.webSocketFrameSent') {
          const label = officeClickLabel(this.labels, payload);
          if (label !== null) this.clickHandler?.(label);
        }
      });
    } catch {
      // Already attached or unavailable: click observation is off; the office view itself is unaffected.
    }
  }
}

export function registerOfficeIpc(deps: { manager: OfficeViewManager; isTrustedSender: (url: string) => boolean }): void {
  ipcMain.on('aik:office-visible', (event, visible: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return;
    if (visible === true) deps.manager.show();
    else deps.manager.hide();
  });
  ipcMain.on('aik:office-bounds', (event, raw: unknown) => {
    if (!deps.isTrustedSender(event.senderFrame?.url ?? '')) return;
    const bounds = parseOfficeBounds(raw);
    if (bounds) deps.manager.setBounds(bounds);
  });
  ipcMain.on('aik:office-agent-click', (event, label: unknown) => {
    deps.manager.acceptAgentClick(event.sender.id, label);
  });
}
