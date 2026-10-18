import type { EventEnvelope } from './events.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface BridgeResponse {
  status: number;
  body: unknown;
}
export type OrchestratorState = 'starting' | 'ready' | 'restarting' | 'crash-loop' | 'fatal' | 'stopped';
export interface SystemState {
  state: OrchestratorState;
  fatal: { kind: 'database_corrupt' | 'startup_failed'; message: string } | null;
}

/** The only API the renderer can reach (exposed by the preload as `window.api`). */
export interface AikWindowApi {
  request(method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string): Promise<BridgeResponse>;
  pickDirectory(): Promise<string | null>;
  systemState(): Promise<SystemState>;
  restoreLatestBackup(): Promise<{ ok: true; restoredFrom: string } | { ok: false; reason: string }>;
  restartOrchestrator(): Promise<void>;
  events: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  system: { subscribe(listener: (state: SystemState) => void): () => void };
}
