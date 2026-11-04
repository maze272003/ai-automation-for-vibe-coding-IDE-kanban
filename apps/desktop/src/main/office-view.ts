// apps/desktop/src/main/office-view.ts — embeds the office web UI tokenless (read-only,
// enforced server-side by pixel-agents) in a WebContentsView layered over the renderer's
// /office route. An <iframe> is not viable in production: app:// is a secure scheme and an
// http subframe would be blocked as mixed content (spec 2026-11-04).
import type { OfficeBounds } from '@aik/contracts';
import { ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import { getOfficeContext, parseOfficeBounds } from './office-context.ts';

export class OfficeViewManager {
  private view: WebContentsView | null = null;
  /** Origin the current view loaded; a server restart picks a new ephemeral port. */
  private loadedOrigin: string | null = null;
  private visible = false;
  private bounds: OfficeBounds | null = null;

  constructor(private readonly win: BrowserWindow) {}

  private ensureView(): WebContentsView | null {
    const office = getOfficeContext();
    if (!office || this.win.isDestroyed()) return null;
    const origin = `${office.url}/`;
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
      this.view.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origin)) event.preventDefault();
      });
      this.win.contentView.addChildView(this.view);
      void this.view.webContents.loadURL(origin);
      this.loadedOrigin = origin;
    } else if (this.loadedOrigin !== origin) {
      // The office server was restarted (e.g. the feature toggled off then on) and its
      // new instance has a new ephemeral port: reload the existing view to the live
      // origin instead of leaving it on a dead one.
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
    this.view.webContents.close();
    this.view = null;
    this.loadedOrigin = null;
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
}
