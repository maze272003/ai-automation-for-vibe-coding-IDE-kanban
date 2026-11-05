// apps/ui/src/components/code/terminal-panel.tsx — bottom-drawer terminal for the Code tab
// (Phase 5.3 spec §Component 6, IDE-5). Exactly one ConPTY session per mounted panel.
import type { TerminalOpenResult } from '@aik/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { chunkInput, clampGrid, terminalNotice, xtermTheme } from '../../lib/terminal.ts';
import { Button } from '../ui/button.tsx';

export interface TerminalPanelProps {
  /** Directory the first session spawns in; "Change directory" moves later sessions. */
  defaultCwd: string;
  onClose(): void;
}

/** Rough char cell at xterm's default 12 px font; only seeds the grid until the first fit(). */
const CELL_WIDTH_PX = 7.2;
const CELL_HEIGHT_PX = 14.4;
const DEFAULT_GRID = clampGrid(80, 24);

/** Estimates a grid from the laid-out container, or falls back to a sensible 80×24. */
function initialGrid(width: number, height: number): { cols: number; rows: number } {
  if (width <= 0 || height <= 0) return DEFAULT_GRID;
  return clampGrid(Math.round(width / CELL_WIDTH_PX), Math.round(height / CELL_HEIGHT_PX));
}

/** Middle truncation keeps the root end and the leaf folder of a long path readable. */
function middleTruncate(value: string, max = 48): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

function isDarkMode(): boolean {
  return typeof document === 'undefined' ? true : document.documentElement.classList.contains('dark');
}

/**
 * The integrated terminal panel: an xterm.js view wired to one desktop-main ConPTY
 * session over `window.api.terminal` (Phase 5.3 spec §Component 6, IDE-5). The xterm
 * instance and the session are created together in the open effect and torn down
 * together in its cleanup, so a StrictMode remount can never leak a shell — an open
 * that resolves after cancellation is closed fire-and-forget (spec decision T-13).
 */
export function TerminalPanel({ defaultCwd, onClose }: TerminalPanelProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [restartToken, setRestartToken] = useState(0);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [failed, setFailed] = useState<TerminalOpenResult | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  const opening = sessionId === null && failed === null;

  // One open flow per (cwd, restartToken): create the terminal against the laid-out
  // container, then ask desktop main for the session at the fitted, clamped grid.
  useEffect(() => {
    let cancelled = false;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    setFailed(null);
    setExitCode(null);
    setSessionId(null);

    const mount = host.current;
    const seeded = mount ? initialGrid(mount.clientWidth, mount.clientHeight) : DEFAULT_GRID;
    const term = new Terminal({
      theme: xtermTheme(isDarkMode()),
      cols: seeded.cols,
      rows: seeded.rows,
      fontFamily: 'Consolas, "Courier New", monospace',
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (mount) {
      term.open(mount);
      fit.fit();
    }
    const fitted = clampGrid(term.cols, term.rows);

    void window.api.terminal.open({ cwd, cols: fitted.cols, rows: fitted.rows }).then(
      (result) => {
        if (cancelled) {
          // The effect was cleaned up (dev remount, restart or unmount) while the
          // invoke was in flight: never attach — close so nothing leaks (spec T-13).
          if (result.ok) void window.api.terminal.close(result.id);
          return;
        }
        if (!result.ok) {
          setFailed(result);
          if (termRef.current === term) termRef.current = null;
          if (fitRef.current === fit) fitRef.current = null;
          term.dispose();
          return;
        }
        idRef.current = result.id;
        setSessionId(result.id);
        term.onData((data) => {
          const id = idRef.current;
          if (id === null) return;
          for (const chunk of chunkInput(data)) void window.api.terminal.write(id, chunk);
        });
        offData = window.api.terminal.onData((event) => {
          if (event.id === idRef.current) term.write(event.data);
        });
        offExit = window.api.terminal.onExit((event) => {
          if (event.id !== idRef.current) return;
          // node-pty delivers exit ~1 s after the last output: keep the buffer
          // visible and let the ended line take over the status strip.
          idRef.current = null;
          setExitCode(event.exitCode);
        });
        term.focus();
      },
      () => {
        // The IPC layer refuses rather than throws, so this only fires if the channel
        // itself is gone; surface it through the same failed-open affordance.
        if (cancelled) return;
        setFailed({ ok: false, reason: 'BAD_REQUEST' });
        if (termRef.current === term) termRef.current = null;
        if (fitRef.current === fit) fitRef.current = null;
        term.dispose();
      },
    );

    return () => {
      cancelled = true;
      offData?.();
      offExit?.();
      const id = idRef.current;
      idRef.current = null;
      if (id !== null) void window.api.terminal.close(id);
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      term.dispose();
    };
  }, [cwd, restartToken]);

  // Refit on container size changes and push the clamped grid to the session. With no
  // live id (still opening, or the shell already exited) only the local refit runs.
  useEffect(() => {
    const mount = host.current;
    if (!mount) return;
    const observer = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      fit.fit();
      const id = idRef.current;
      if (id === null) return;
      const grid = clampGrid(term.cols, term.rows);
      void window.api.terminal.resize(id, grid.cols, grid.rows);
    });
    observer.observe(mount);
    return () => observer.disconnect();
  }, []);

  // Follow the dark/light class on <html> (same pattern as the CodePage Monaco effect).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const element = document.documentElement;
    const observer = new MutationObserver(() => {
      const term = termRef.current;
      if (term) term.options.theme = xtermTheme(element.classList.contains('dark'));
    });
    observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Restart and Retry share the flow: bumping the token re-runs the open effect, whose
  // cleanup closes the previous session first — that is also how "Change directory"
  // closes the old shell before opening one at the picked folder.
  const restart = () => {
    setRestartToken((value) => value + 1);
  };

  const changeDirectory = () => {
    void window.api.pickDirectory().then((picked) => {
      if (!picked) return;
      setCwd(picked);
      setRestartToken((value) => value + 1);
    });
  };

  return (
    <section
      id="code-terminal-panel"
      data-testid="code-terminal-panel"
      role="region"
      aria-label="Terminal"
      aria-busy={opening}
      className="flex h-[220px] shrink-0 flex-col border-t border-glass-border bg-surface/50"
      onClick={() => termRef.current?.focus()}
    >
      <div className="flex items-center gap-2 border-b border-glass-border bg-surface/40 px-3 py-1.5">
        <span
          data-testid="code-terminal-notice"
          title="Commands run unsandboxed with your Windows user rights (spec T-6 honesty badge)"
          className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning-foreground"
        >
          Runs with your Windows user rights
        </span>
        <span data-testid="code-terminal-cwd-label" title={cwd} className="min-w-0 truncate font-mono text-xs text-muted">
          {middleTruncate(cwd)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button size="sm" data-testid="code-terminal-cwd" onClick={changeDirectory}>Change directory</Button>
          <Button size="sm" data-testid="code-terminal-close" onClick={onClose}>Close</Button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={host}
          tabIndex={0}
          aria-label="Terminal view"
          className="h-full w-full"
          onFocus={(event) => {
            // The container is the keyboard tab stop; forward tab focus into xterm's textarea.
            if (event.target === event.currentTarget) termRef.current?.focus();
          }}
        />
        {opening && (
          <p role="status" className="pointer-events-none absolute left-3 top-2 text-xs text-muted-2">Starting terminal…</p>
        )}
        {failed && (
          <div className="absolute inset-0 grid place-items-center bg-surface/80 p-4 text-center">
            <p role="alert" data-testid="code-terminal-error" className="text-xs text-danger-foreground">
              {terminalNotice(failed, null)}
            </p>
            <Button size="sm" data-testid="code-terminal-retry" className="mt-2" onClick={restart}>Retry</Button>
          </div>
        )}
        {exitCode !== null && (
          <div
            data-testid="code-terminal-exited"
            role="status"
            className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-glass-border bg-surface/90 px-3 py-1.5 text-xs text-muted"
          >
            <span>{terminalNotice(null, exitCode)}</span>
            <Button size="sm" data-testid="code-terminal-restart" className="ml-auto" onClick={restart}>Restart</Button>
          </div>
        )}
      </div>
    </section>
  );
}
