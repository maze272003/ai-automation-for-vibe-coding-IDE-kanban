// apps/desktop/src/main/terminal.ts — TerminalManager (Phase 5.3 spec §Component design 2).
// Electron-free on purpose: only node builtins and node-pty, so unit tests import this
// module directly. Owns capped ConPTY sessions: output is coalesced per session and
// flushed over `send`, every kill is belt-and-braces (pty.kill + taskkill /T /F, spec
// T-9) and owner lifetime hooks (T-10) close the hard-reload / renderer-crash leak —
// SPA pushState navigations are exempt via `isSameDocument`, and `open` never spawns
// after killAll() or for an already-destroyed owner.
// Never logs: terminal bytes must not be printed or persisted.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node-pty';
import { TERMINAL_MAX_SESSIONS, type TerminalOpenOptions, type TerminalOpenResult } from '@aik/contracts';

/** The structural subset of node-pty's IPty the manager relies on (IPty is assignable to this). */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
}

/** Fork options forwarded to the pty factory (subset of node-pty's own options). */
export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Spawns a pty; the default is node-pty's `spawn`. */
export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

/**
 * The session owner: a webContents. Consumed as an EventEmitter-shaped object so the
 * manager stays electron-import-free. `removeListener` (present on both EventEmitter
 * and webContents) is what lets the manager drop its lifetime hooks once the owner
 * runs out of sessions.
 */
export interface OwnerLike {
  readonly id: number;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  /** True once the real webContents is gone; test fakes may omit it. */
  isDestroyed?(): boolean;
}

export interface TerminalManagerDeps {
  /** Test seam: pty factory (default: node-pty spawn). */
  createPty?: PtyFactory;
  /** Test seam: deferred flush scheduler (default: setImmediate). */
  schedule?: (cb: () => void) => void;
  /** Test seam: synchronous process-tree kill (default: win32 taskkill /PID /T /F). */
  killTree?: (pid: number) => void;
  /** Delivers `aik:terminal-data` / `aik:terminal-exit` to the renderer. */
  send: (channel: string, payload: unknown) => void;
}

interface TerminalSession {
  readonly id: number;
  readonly pty: PtyLike;
  readonly ownerId: number;
  readonly cwd: string;
  readonly pid: number;
  buffer: string;
}

/** Owner events that mean "this renderer is going away" (spec T-10). */
const OWNER_LIFETIME_EVENTS = ['did-start-navigation', 'render-process-gone', 'destroyed'] as const;

/** The slice of Electron's did-start-navigation details the manager reads. */
interface NavigationDetails {
  isSameDocument?: boolean;
}

/** Owner-lifetime listener shape: did-start-navigation passes details, the others pass nothing. */
type OwnerListener = (details?: NavigationDetails) => void;

/** Default killTree (spec T-9): synchronous tree kill on win32, errors swallowed, no-op elsewhere. */
function defaultKillTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // the shell may already be gone — a failed tree kill must never propagate
  }
}

export class TerminalManager {
  private readonly sessions = new Map<number, TerminalSession>();
  /** Unsubscribe callbacks for the lifetime hooks, keyed by owner id. */
  private readonly ownerHooks = new Map<number, Array<() => void>>();
  private nextId = 1;
  /** Set by killAll(): once teardown began, open() must never spawn again. */
  private disposed = false;
  private readonly createPty: PtyFactory;
  private readonly schedule: (cb: () => void) => void;
  private readonly killTree: (pid: number) => void;
  private readonly send: (channel: string, payload: unknown) => void;

  constructor(deps: TerminalManagerDeps) {
    this.createPty = deps.createPty ?? spawn;
    this.schedule = deps.schedule ?? ((cb) => setImmediate(cb));
    this.killTree = deps.killTree ?? defaultKillTree;
    this.send = deps.send;
  }

  /** Opens a shell session for `owner` at `payload.cwd` (absent → home dir); ids are monotonic from 1. */
  async open(payload: TerminalOpenOptions, owner: OwnerLike): Promise<TerminalOpenResult> {
    if (this.sessions.size >= TERMINAL_MAX_SESSIONS) return { ok: false, reason: 'TOO_MANY_SESSIONS' };
    const cwd = payload.cwd ?? os.homedir();
    try {
      const stats = await fs.promises.stat(cwd);
      if (!stats.isDirectory()) return { ok: false, reason: 'INVALID_CWD' };
    } catch {
      return { ok: false, reason: 'INVALID_CWD' };
    }
    // The stat above awaited, so teardown may have raced us: never spawn into a manager
    // that is shutting down, nor for an owner whose renderer is already destroyed.
    if (this.disposed) return { ok: false, reason: 'SPAWN_FAILED', message: 'terminal manager is shutting down' };
    if (owner.isDestroyed?.()) return { ok: false, reason: 'SPAWN_FAILED', message: 'terminal owner is destroyed' };
    // A concurrent open may also have taken the last session slot meanwhile.
    if (this.sessions.size >= TERMINAL_MAX_SESSIONS) return { ok: false, reason: 'TOO_MANY_SESSIONS' };
    let pty: PtyLike;
    try {
      pty = this.createPty(process.env.COMSPEC ?? 'cmd.exe', [], {
        name: 'xterm-256color',
        cols: payload.cols,
        rows: payload.rows,
        cwd,
        env: process.env,
      });
    } catch (err) {
      return { ok: false, reason: 'SPAWN_FAILED', message: err instanceof Error ? err.message : String(err) };
    }
    const id = this.nextId++;
    const session: TerminalSession = { id, pty, ownerId: owner.id, cwd, pid: pty.pid, buffer: '' };
    this.sessions.set(id, session);
    pty.onData((data) => {
      session.buffer += data;
      this.schedule(() => this.flush(id));
    });
    pty.onExit(({ exitCode }) => {
      const live = this.sessions.get(id);
      if (!live) return; // closed/killed earlier — node-pty's delayed exit event is a no-op
      this.flush(id); // deliver the output tail before the exit event
      this.sessions.delete(id); // first, so the session dies even if the exit send throws
      try {
        this.send('aik:terminal-exit', { id, exitCode });
      } catch {
        // a throwing send must never propagate into node-pty's exit callback
      }
      this.dropOwnerHooksIfIdle(live.ownerId);
    });
    this.ensureOwnerHooks(owner);
    return { ok: true, id, cwd };
  }

  /** Writes to the session's shell; false on unknown id or a throwing pty (exited-but-undeleted race). */
  write(id: number, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      session.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  /** Resizes the session's grid; false on unknown id or a throwing pty. */
  resize(id: number, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  /** Kills the session and its console-attached process tree; idempotent (unknown id → false). */
  close(id: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.killSession(session);
    this.dropOwnerHooksIfIdle(session.ownerId);
    return true;
  }

  /** Kills every session synchronously, drops all owner hooks and refuses later opens. Sends nothing. Idempotent. */
  killAll(): void {
    this.disposed = true; // any open still awaiting its stat must refuse to spawn afterwards
    for (const session of [...this.sessions.values()]) this.killSession(session);
    for (const offs of [...this.ownerHooks.values()]) {
      for (const off of offs) off();
    }
    this.ownerHooks.clear();
  }

  /** Serializable session snapshot for the e2e seam (raw manager objects cannot cross app.evaluate). */
  sessionsInfo(): Array<{ id: number; pid: number }> {
    return [...this.sessions.values()].map(({ id, pid }) => ({ id, pid }));
  }

  private flush(id: number): void {
    const session = this.sessions.get(id);
    if (!session || session.buffer === '') return; // dropped session or already-drained buffer
    const data = session.buffer;
    session.buffer = ''; // drain first: a throwing send must not grow or re-send the buffer
    try {
      this.send('aik:terminal-data', { id, data });
    } catch {
      // a throwing send must never propagate into the pty/scheduler callbacks
    }
  }

  private killSession(session: TerminalSession): void {
    this.sessions.delete(session.id); // first, so any reentrant pty event finds nothing
    try {
      session.pty.kill();
    } catch {
      // already dead — nothing to do
    }
    try {
      this.killTree(session.pid);
    } catch {
      // best-effort belt-and-braces (spec T-9); a failed tree kill must not break teardown
    }
  }

  private killSessionsOfOwner(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.killSession(session);
    }
    this.dropOwnerHooksIfIdle(ownerId); // the owner is idle now — its hooks disarm themselves
  }

  private ensureOwnerHooks(owner: OwnerLike): void {
    if (this.ownerHooks.has(owner.id)) return; // one subscription set per distinct owner
    const offs = OWNER_LIFETIME_EVENTS.map((event) => {
      // did-start-navigation also fires for History-API (SPA) route changes; those carry
      // isSameDocument:true and must NOT kill live sessions. Real document navigations
      // (hard reload, link) carry isSameDocument:false → kill. A bare emit with no
      // details is treated as a real navigation (leak-safe default; Electron always
      // passes details for this event). The other two events are unconditional kills.
      const listener: OwnerListener =
        event === 'did-start-navigation'
          ? (details) => {
              if (details?.isSameDocument !== true) this.killSessionsOfOwner(owner.id);
            }
          : () => this.killSessionsOfOwner(owner.id);
      owner.on(event, listener);
      return () => owner.removeListener(event, listener);
    });
    this.ownerHooks.set(owner.id, offs);
  }

  private dropOwnerHooksIfIdle(ownerId: number): void {
    const offs = this.ownerHooks.get(ownerId);
    if (!offs) return;
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId) return; // live sessions remain — hooks stay armed
    }
    this.ownerHooks.delete(ownerId);
    for (const off of offs) off();
  }
}
