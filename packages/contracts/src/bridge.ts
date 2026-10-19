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

/** One model offered by the managed OpenCode server (flattened from its model list). */
export interface OpencodeModelInfo {
  providerID: string;
  id: string;
  name: string;
  /** Context window in tokens, when the server reports it. */
  contextLimit: number | null;
  /** True when the server reports zero input and output cost. */
  free: boolean;
}

export type OpencodeModelsResult = { ok: true; models: OpencodeModelInfo[] } | { ok: false; error: string };
export type OpencodeChatResult = { ok: true; text: string } | { ok: false; error: string };
export type OpencodeLoginStartResult = { ok: true; url: string; code: string } | { ok: false; error: string };
export type OpencodeLoginWaitResult = { ok: true } | { ok: false; error: string };

/** User's choice of which OpenCode the app runs (spec §18.2 deviation, user-directed): managed install or personal CLI. */
export type OpencodeMode = 'managed' | 'personal';
export interface AppSettings {
  opencodeMode: OpencodeMode;
}

/** The only API the renderer can reach (exposed by the preload as `window.api`). */
export interface AikWindowApi {
  request(method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string): Promise<BridgeResponse>;
  pickDirectory(): Promise<string | null>;
  systemState(): Promise<SystemState>;
  restoreLatestBackup(): Promise<{ ok: true; restoredFrom: string } | { ok: false; reason: string }>;
  restartOrchestrator(): Promise<void>;
  opencodeStatus(): Promise<OpencodeStatus>;
  installOpencode(): Promise<OpencodeInstallResult>;
  opencodeModels(): Promise<OpencodeModelsResult>;
  opencodeChat(model: { providerID: string; id: string }, prompt: string): Promise<OpencodeChatResult>;
  opencodeSignedIn(): Promise<boolean>;
  opencodeLoginStart(): Promise<OpencodeLoginStartResult>;
  opencodeLoginWait(): Promise<OpencodeLoginWaitResult>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<AppSettings>;
  openTerminalCli(options?: { sessionId?: string; cwd?: string }): Promise<{ ok: boolean; error?: string }>;
  events: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  system: { subscribe(listener: (state: SystemState) => void): () => void };
}
