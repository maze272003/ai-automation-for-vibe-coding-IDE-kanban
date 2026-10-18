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

/** State of the managed OpenCode install (spec §18.2): detection result, never a secret. */
export interface OpencodeStatus {
  /** Version this app ships and expects. */
  pinned: string;
  /** Absolute path of the executable that would be used (custom path via AIK_OPENCODE_EXE wins), or null. */
  exe: string | null;
  installed: boolean;
  version: string | null;
  matchesPin: boolean;
}

export type OpencodeInstallResult = { ok: true; version: string } | { ok: false; error: string };

/** The only API the renderer can reach (exposed by the preload as `window.api`). */
export interface AikWindowApi {
  request(method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string): Promise<BridgeResponse>;
  pickDirectory(): Promise<string | null>;
  systemState(): Promise<SystemState>;
  restoreLatestBackup(): Promise<{ ok: true; restoredFrom: string } | { ok: false; reason: string }>;
  restartOrchestrator(): Promise<void>;
  opencodeStatus(): Promise<OpencodeStatus>;
  installOpencode(): Promise<OpencodeInstallResult>;
  events: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  system: { subscribe(listener: (state: SystemState) => void): () => void };
}
