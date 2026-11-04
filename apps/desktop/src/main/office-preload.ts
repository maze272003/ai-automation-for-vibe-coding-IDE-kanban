// apps/desktop/src/main/office-preload.ts — click observer for the embedded pixel-agents
// office (spec 2026-11-04-office-agent-activity, security amendment). Their SPA sends
// {type:'focusAgent', id} over its WebSocket when a character is clicked and learns
// id→directoryName from agentCreated/existingAgents broadcasts. This preload only
// OBSERVES those frames (pass-through) and sends one string — the character label —
// on one IPC channel. Sandbox + contextIsolation stay on; no other page API is touched.
import { ipcRenderer } from 'electron';

const labels = new Map<number, string>();

const note = (id: unknown, name: unknown): void => {
  if (typeof id === 'number' && typeof name === 'string' && name !== '') labels.set(id, name);
};

const onFrame = (raw: unknown): void => {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Record<string, unknown>;
    if (msg.type === 'agentCreated') {
      note(msg.id, msg.directoryName);
    } else if (msg.type === 'agentClosed' && typeof msg.id === 'number') {
      labels.delete(msg.id);
    } else if (msg.type === 'existingAgents' && typeof msg.directoryNames === 'object' && msg.directoryNames !== null) {
      for (const [id, name] of Object.entries(msg.directoryNames as Record<string, string>)) note(Number(id), name);
    } else if (msg.type === 'focusAgent' && typeof msg.id === 'number') {
      const label = labels.get(msg.id);
      if (label !== undefined) ipcRenderer.send('aik:office-agent-click', label);
    }
  } catch {
    // never break the page on a non-JSON frame
  }
};

const OriginalWebSocket = window.WebSocket;
class ObservedWebSocket extends OriginalWebSocket {
  constructor(url: URL | string, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', (event: MessageEvent) => onFrame((event as MessageEvent).data));
  }
  override send(data: string): void {
    onFrame(data);
    super.send(data);
  }
}
window.WebSocket = ObservedWebSocket as unknown as typeof WebSocket;
