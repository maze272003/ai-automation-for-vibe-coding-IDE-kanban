import type { SessionUsage } from './usage.ts';
import type { DiagnosticsExportResult } from './diagnostics.ts';
import type { EventEnvelope } from './events.ts';
import type { OfficePreferences } from './office.ts';

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
export type OpencodeChatResult = { ok: true; text: string; usage?: SessionUsage | null; durationMs?: number } | { ok: false; error: string };
export type OpencodeLoginStartResult = { ok: true; url: string; code: string } | { ok: false; error: string };
export type OpencodeLoginWaitResult = { ok: true } | { ok: false; error: string };

/** User's choice of which OpenCode the app runs (spec §18.2 deviation, user-directed): managed install or personal CLI. */
export type OpencodeMode = 'managed' | 'personal';
export interface AppSettings {
  opencodeMode: OpencodeMode;
  /** 3D Agent Office preferences (spec 2026-11-08). */
  office3d: OfficePreferences;
}

/** Result of `aik:terminal-open` (Phase 5.3 spec §IPC contract): a live session id, or why it was refused. */
export type TerminalOpenResult =
  | { ok: true; id: number; cwd: string }
  | { ok: false; reason: 'BAD_REQUEST' | 'TOO_MANY_SESSIONS' | 'INVALID_CWD' | 'SPAWN_FAILED'; message?: string };
/** One batch of shell output forwarded over `aik:terminal-data` (data is unbounded shell output). */
export interface TerminalDataEvent {
  id: number;
  data: string;
}
/** A session's shell exit forwarded over `aik:terminal-exit` (may lag the last data by ~1 s). */
export interface TerminalExitEvent {
  id: number;
  exitCode: number;
}
/** Open arguments; mirrors `TerminalOpenPayload` (contracts terminal.ts) without pulling zod into this surface. */
export interface TerminalOpenOptions {
  cwd?: string;
  cols: number;
  rows: number;
}

/** Where main should open a story's CLI session (spec §6.3, §5.11): resolved by the orchestrator
 *  from the story's own rows. The renderer never supplies a folder or session id. */
export type OpenCliTargetDTO =
  | { runtime: 'opencode'; sessionRef: string; cwd: string }
  | { available: false; reason: string };

/** Result of `aik:open-terminal-cli` (spec §6.3): a visible console launch with argv only. */
export type OpenCliResult = { ok: true } | { ok: false; reason: string };

/** The only API the renderer can reach (exposed by the preload as `window.api`). */
export interface AikWindowApi {
  request(method: HttpMethod, path: string, body?: unknown, idempotencyKey?: string): Promise<BridgeResponse>;
  pickDirectory(): Promise<string | null>;
  systemState(): Promise<SystemState>;
  restoreLatestBackup(): Promise<{ ok: true; restoredFrom: string } | { ok: false; reason: string }>;
  /** Saves the redacted diagnostics archive through a native Save dialog in main; the renderer never sees it. */
  exportDiagnostics(): Promise<DiagnosticsExportResult>;
  restartOrchestrator(): Promise<void>;
  /** Restarts the isolated OpenCode server so a newly connected provider appears in the model list. */
  restartOpencode(): Promise<void>;
  opencodeStatus(): Promise<OpencodeStatus>;
  installOpencode(): Promise<OpencodeInstallResult>;
  opencodeModels(): Promise<OpencodeModelsResult>;
  opencodeChat(model: { providerID: string; id: string }, prompt: string): Promise<OpencodeChatResult>;
  opencodeSignedIn(): Promise<boolean>;
  opencodeLoginStart(): Promise<OpencodeLoginStartResult>;
  opencodeLoginWait(): Promise<OpencodeLoginWaitResult>;
  getAppSettings(): Promise<AppSettings>;
  setAppSettings(settings: AppSettings): Promise<AppSettings>;
  /** Opens the story's OpenCode session in an external console. Main looks up the worktree and
   *  session id from the orchestrator and spawns argv only — never a shell (spec §6.3). */
  openTerminalCli(storyId: number): Promise<OpenCliResult>;
  events: { subscribe(listener: (event: EventEnvelope) => void): () => void };
  system: { subscribe(listener: (state: SystemState) => void): () => void };
  terminal: {
    /** Opens a ConPTY session at `cwd` (main falls back to the home directory when absent). */
    open(options: TerminalOpenOptions): Promise<TerminalOpenResult>;
    /** Writes UTF-8 text to the session's shell; false = unknown id / invalid / exited. */
    write(id: number, data: string): Promise<boolean>;
    /** Resizes the session's grid; false = unknown id / invalid / exited. */
    resize(id: number, cols: number, rows: number): Promise<boolean>;
    /** Kills the session and its console-attached process tree. */
    close(id: number): Promise<boolean>;
    /** Subscribes to `aik:terminal-data` output events; the return value unsubscribes. */
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    /** Subscribes to `aik:terminal-exit` events; the return value unsubscribes. */
    onExit(listener: (event: TerminalExitEvent) => void): () => void;
  };
}
