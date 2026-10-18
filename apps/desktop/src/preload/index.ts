import type { AikWindowApi, BridgeResponse, EventEnvelope, HttpMethod, SystemState } from '@aik/contracts';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api: AikWindowApi = {
  request: (method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string) =>
    ipcRenderer.invoke('aik:request', { method, path, body, idempotencyKey }) as Promise<BridgeResponse>,
  pickDirectory: () => ipcRenderer.invoke('aik:pick-directory') as Promise<string | null>,
  systemState: () => ipcRenderer.invoke('aik:system-state') as Promise<SystemState>,
  restoreLatestBackup: () => ipcRenderer.invoke('aik:restore-latest-backup'),
  restartOrchestrator: () => ipcRenderer.invoke('aik:restart-orchestrator') as Promise<void>,
  opencodeStatus: () => ipcRenderer.invoke('aik:opencode-status'),
  installOpencode: () => ipcRenderer.invoke('aik:opencode-install'),
  opencodeModels: () => ipcRenderer.invoke('aik:opencode-models'),
  opencodeChat: (model, prompt) => ipcRenderer.invoke('aik:opencode-chat', { ...model, prompt }),
  opencodeSignedIn: () => ipcRenderer.invoke('aik:opencode-signed-in') as Promise<boolean>,
  opencodeLoginStart: () => ipcRenderer.invoke('aik:opencode-login-start'),
  opencodeLoginWait: () => ipcRenderer.invoke('aik:opencode-login-wait'),
  events: {
    subscribe(listener) {
      const handler = (_e: IpcRendererEvent, value: EventEnvelope) => listener(value);
      ipcRenderer.on('aik:event', handler);
      return () => {
        ipcRenderer.removeListener('aik:event', handler);
      };
    },
  },
  system: {
    subscribe(listener) {
      const handler = (_e: IpcRendererEvent, value: SystemState) => listener(value);
      ipcRenderer.on('aik:system', handler);
      return () => {
        ipcRenderer.removeListener('aik:system', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
