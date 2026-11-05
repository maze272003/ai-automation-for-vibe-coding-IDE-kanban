// apps/ui/src/routes/code-page.tsx
import type { FileContentDTO, FileSearchMatchDTO, ProjectDTO } from '@aik/contracts';
import { Link, useBlocker, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../components/code/code-editor.tsx';
import { FileExplorer } from '../components/code/file-explorer.tsx';
import { SearchPanel } from '../components/code/search-panel.tsx';
import { TerminalPanel } from '../components/code/terminal-panel.tsx';
import { TopBar } from '../components/shell/top-bar.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { ApiRequestError, api } from '../lib/api.ts';
import { fileContent, languageForPath, saveFile } from '../lib/files.ts';
import { SHORTCUTS_BY_ID, matchesShortcut } from '../lib/shortcuts.ts';

const SAVE_CHORD = SHORTCUTS_BY_ID['editor.save'].chord;
const SEARCH_CHORD = SHORTCUTS_BY_ID['editor.search'].chord;
const TERMINAL_CHORD = SHORTCUTS_BY_ID['view.terminal'].chord;

interface LoadedFile {
  path: string;
  content: string;
  sha256: string | null;
  binary: boolean;
  truncated: boolean;
  editable: boolean;
}

interface PendingOpen {
  path: string;
  line?: number;
}

const messageOf = (err: unknown) => (err instanceof ApiRequestError ? err.reason : err instanceof Error ? err.message : String(err));

export function CodePage() {
  const params = useParams({ strict: false }) as { projectId?: string };
  const id = Number(params.projectId);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [buffer, setBuffer] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [explorerRefresh, setExplorerRefresh] = useState(0);
  const [dark, setDark] = useState(() => (typeof document === 'undefined' ? true : document.documentElement.classList.contains('dark')));
  const request = useRef(0);
  const fileRef = useRef<LoadedFile | null>(null);
  const bufferRef = useRef('');
  const savingRef = useRef(false);
  const saveToken = useRef(0);
  const saveRef = useRef<() => void>(() => undefined);
  const dirty = file !== null && buffer !== file.content;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    disabled: !dirty,
    withResolver: true,
  });

  fileRef.current = file;
  bufferRef.current = buffer;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const element = document.documentElement;
    const observer = new MutationObserver(() => setDark(element.classList.contains('dark')));
    observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // `/projects/:id/code` keeps the same component mounted when only the param changes.
    request.current += 1;
    saveToken.current += 1;
    savingRef.current = false;
    setSelectedPath(null);
    setFile(null);
    setBuffer('');
    setLoading(false);
    setSaving(false);
    setError(null);
    setConflict(null);
    setPendingOpen(null);
    setReloadOpen(false);
    setSearchOpen(false);
    setTerminalOpen(false);
    setRevealLine(null);
    setResetToken((value) => value + 1);
  }, [id]);

  useEffect(() => {
    void api.get<ProjectDTO>(`/projects/${id}`).then(setProject, () => setProject(null));
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesShortcut(event, SAVE_CHORD)) {
        event.preventDefault();
        saveRef.current();
      } else if (matchesShortcut(event, TERMINAL_CHORD)) {
        // Toggle the integrated terminal (Phase 5.3 spec §Component 7, IDE-5).
        event.preventDefault();
        setTerminalOpen((value) => !value);
      } else if (matchesShortcut(event, SEARCH_CHORD)) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (
        event.key === 'Escape' &&
        searchOpen &&
        pendingOpen === null &&
        !reloadOpen &&
        blocker.status !== 'blocked'
      ) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blocker.status, pendingOpen, reloadOpen, searchOpen]);

  const loadFile = async (path: string, line?: number) => {
    const requestId = request.current + 1;
    request.current = requestId;
    // Ignore any save that was still in flight for the previous buffer.
    saveToken.current += 1;
    savingRef.current = false;
    setSaving(false);
    setSelectedPath(path);
    setRevealLine(null);
    setConflict(null);
    setError(null);
    setLoading(true);
    try {
      const dto: FileContentDTO = await fileContent(id, path);
      if (request.current !== requestId) return;
      // Swap the buffer only after a successful fetch; a failed reload must not erase edits.
      setFile({
        path: dto.path,
        content: dto.content ?? '',
        sha256: dto.sha256,
        binary: dto.binary,
        truncated: dto.truncated,
        editable: dto.editable,
      });
      setBuffer(dto.content ?? '');
      setRevealLine(line ?? null);
      setResetToken((value) => value + 1);
    } catch (err) {
      if (request.current !== requestId) return;
      setError(messageOf(err));
    } finally {
      if (request.current === requestId) setLoading(false);
    }
  };

  const requestOpen = (path: string, line?: number) => {
    if (file?.path === path) {
      if (line !== undefined) setRevealLine(line);
      return;
    }
    if (dirty) {
      setPendingOpen(line === undefined ? { path } : { path, line });
      return;
    }
    void loadFile(path, line);
  };

  const confirmPending = () => {
    const pending = pendingOpen;
    setPendingOpen(null);
    if (pending) void loadFile(pending.path, pending.line);
  };

  const reloadNow = () => {
    if (file) void loadFile(file.path, revealLine ?? undefined);
  };

  const requestReload = () => {
    if (dirty) setReloadOpen(true);
    else reloadNow();
  };

  const save = async () => {
    const current = fileRef.current;
    const text = bufferRef.current;
    if (!current || !current.editable || current.sha256 === null || text === current.content || savingRef.current || conflict !== null) {
      return;
    }
    const token = saveToken.current + 1;
    saveToken.current = token;
    const path = current.path;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await saveFile(id, { path, content: text, expectedSha256: current.sha256 });
      // The user may have opened another file (or reloaded) while the PUT was in flight.
      if (saveToken.current !== token || fileRef.current?.path !== path) return;
      setFile((previous) => (previous && previous.path === path ? { ...previous, content: text, sha256: result.sha256 } : previous));
      setConflict(null);
      setExplorerRefresh((value) => value + 1);
    } catch (err) {
      if (saveToken.current !== token || fileRef.current?.path !== path) return;
      if (err instanceof ApiRequestError && err.code === 'FILE_CHANGED') setConflict(err.reason);
      else setError(messageOf(err));
    } finally {
      if (saveToken.current === token) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  saveRef.current = () => void save();

  const openMatch = (match: FileSearchMatchDTO) => requestOpen(match.path, match.line);
  const title = project ? `${project.key} · ${project.name}` : 'Code';

  return (
    <div className="flex h-full flex-col">
      <TopBar data-testid="code-toolbar" title={title}>
        <nav aria-label="Project views" data-testid="project-tabs" className="inline-flex items-center gap-1 rounded-control border border-glass-border bg-surface-2/60 p-1">
          <Link
            to="/projects/$projectId"
            params={{ projectId: String(id) }}
            activeOptions={{ exact: true }}
            className="rounded-control px-2.5 py-1 text-xs font-semibold text-muted hover:text-foreground"
          >
            Board
          </Link>
          <span aria-current="page" data-testid="tab-code" className="rounded-control bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-soft-foreground underline decoration-2 underline-offset-4">Code</span>
          <Link
            to="/projects/$projectId/git"
            params={{ projectId: String(id) }}
            activeOptions={{ exact: true }}
            data-testid="tab-git"
            className="rounded-control px-2.5 py-1 text-xs font-semibold text-muted hover:text-foreground"
          >
            Git
          </Link>
        </nav>
        <Button
          data-testid="code-terminal-toggle"
          aria-pressed={terminalOpen}
          aria-controls="code-terminal-panel"
          title="Terminal (Ctrl+`)"
          className={terminalOpen ? 'border-accent/40 bg-accent-soft text-accent-soft-foreground' : ''}
          onClick={() => setTerminalOpen((value) => !value)}
        >
          Terminal
        </Button>
        <Button
          id="code-search-toggle"
          data-testid="code-search-toggle"
          aria-pressed={searchOpen}
          aria-controls="code-search-results"
          className="ml-auto"
          onClick={() => setSearchOpen((value) => !value)}
        >
          Search
        </Button>
        <Link to="/" className="ml-2 text-sm font-semibold text-muted hover:text-foreground">← Projects</Link>
      </TopBar>
      {error && (
        <p role="alert" data-testid="code-error" className="px-4 py-2 text-sm text-danger-foreground">{error}</p>
      )}
      <div className="flex min-h-0 flex-1">
        <FileExplorer
          projectId={id}
          selectedPath={selectedPath}
          refreshKey={explorerRefresh}
          refreshPath={file?.path ?? null}
          onSelect={(path) => requestOpen(path)}
        />
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Editor">
          {file ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-glass-border bg-surface/40 px-3 py-1.5">
                <span data-testid="code-file-path" className="min-w-0 truncate font-mono text-xs text-foreground">{file.path}</span>
                {dirty && <span data-testid="code-dirty" className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning-foreground">Unsaved</span>}
                {file.binary && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">binary</span>}
                {file.truncated && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">read-only</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <Button size="sm" data-testid="code-reload" onClick={requestReload} disabled={saving}>Reload</Button>
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="code-save"
                    onClick={() => void save()}
                    disabled={!file.editable || !dirty || saving || loading || conflict !== null || file.sha256 === null}
                    title="Save (Ctrl+S)"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </span>
              </div>
              {conflict && (
                <div role="alert" data-testid="code-conflict" className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                  <span>{conflict}</span>
                  <Button size="sm" data-testid="code-conflict-reload" onClick={requestReload}>Reload from disk</Button>
                </div>
              )}
              {file.binary ? (
                <p data-testid="code-binary-notice" className="grid flex-1 place-items-center p-6 text-sm text-muted">
                  Binary file — preview is not available.
                </p>
              ) : (
                <>
                  {file.truncated && (
                    <p data-testid="code-truncated-notice" className="border-b border-glass-border px-3 py-1.5 text-xs text-muted">
                      This file is larger than 2 MiB — showing a read-only preview.
                    </p>
                  )}
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      path={file.path}
                      value={buffer}
                      language={languageForPath(file.path)}
                      readOnly={!file.editable}
                      dark={dark}
                      revealLine={revealLine}
                      resetToken={resetToken}
                      onChange={(value) => {
                        bufferRef.current = value;
                        setBuffer(value);
                      }}
                      onSave={() => saveRef.current()}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center" data-testid="code-empty">
              {loading ? <p className="text-sm text-muted">Loading file…</p> : <p className="text-sm text-muted">Choose a file to edit, or search across the repository.</p>}
            </div>
          )}
        </section>
        <SearchPanel projectId={id} open={searchOpen} onClose={() => setSearchOpen(false)} onOpenMatch={openMatch} />
      </div>
      {terminalOpen && project ? (
        <TerminalPanel defaultCwd={project.repoPath} onClose={() => setTerminalOpen(false)} />
      ) : null}
      <Dialog open={pendingOpen !== null} title="Discard unsaved changes?" onClose={() => setPendingOpen(null)}>
        <p className="text-sm text-muted">
          <span className="font-mono">{file?.path}</span> has unsaved changes. Opening another file discards them.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setPendingOpen(null)}>Keep editing</Button>
          <Button variant="danger" data-testid="code-discard-confirm" onClick={confirmPending}>Discard and open</Button>
        </div>
      </Dialog>
      <Dialog open={reloadOpen} title="Reload from disk?" onClose={() => setReloadOpen(false)}>
        <p className="text-sm text-muted">Reloading discards your unsaved changes and reads the file from disk.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setReloadOpen(false)}>Keep editing</Button>
          <Button variant="danger" data-testid="code-reload-confirm" onClick={() => { setReloadOpen(false); reloadNow(); }}>Reload</Button>
        </div>
      </Dialog>
      <Dialog open={blocker.status === 'blocked'} title="Leave with unsaved changes?" onClose={() => blocker.reset?.()}>
        <p className="text-sm text-muted">
          <span className="font-mono">{file?.path}</span> has unsaved changes. Leaving this page discards them.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button variant="danger" data-testid="code-leave-confirm" onClick={() => blocker.proceed?.()}>Discard and leave</Button>
        </div>
      </Dialog>
    </div>
  );
}
