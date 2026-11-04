// apps/ui/src/components/code/file-explorer.tsx
import type { FileTreeDTO, FileTreeEntryDTO } from '@aik/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileTree, parentPath } from '../../lib/files.ts';
import { cn } from '../../lib/cn.ts';

export interface FileExplorerProps {
  projectId: number;
  selectedPath: string | null;
  /** Bumped after a save so the cached size/entries for the saved path are refetched. */
  refreshKey?: number;
  refreshPath?: string | null;
  onSelect(path: string): void;
}

/** Deterministic and collision-free: `src/a.ts` and `src_a.ts` must not share a test id. */
export function testIdForPath(path: string): string {
  return encodeURIComponent(path);
}

interface TreeState {
  nodes: Map<string, FileTreeDTO>;
  loading: Set<string>;
  errors: Map<string, string>;
  expanded: Set<string>;
}

const initialState = (): TreeState => ({ nodes: new Map(), loading: new Set(), errors: new Map(), expanded: new Set() });

function stateWith<T>(set: Set<T>, value: T, present: boolean): Set<T> {
  const next = new Set(set);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

function FileGlyph({ type }: { type: FileTreeEntryDTO['type'] }) {
  if (type === 'dir') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent-soft-foreground">
        <path fill="currentColor" d="M1.5 3.25A1.25 1.25 0 0 1 2.75 2h3.4l1.4 1.5h5.7a1.25 1.25 0 0 1 1.25 1.25v7A1.25 1.25 0 0 1 13.25 13h-10.5A1.25 1.25 0 0 1 1.5 11.75v-8.5Z" />
      </svg>
    );
  }
  if (type === 'symlink') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning">
        <path fill="none" stroke="currentColor" strokeWidth="1.4" d="M6.5 9.5 9.5 6.5M5 11l-1 1a2.1 2.1 0 0 1-3-3l2-2a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-2 2a2.1 2.1 0 0 1-3 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-2">
      <path fill="none" stroke="currentColor" strokeWidth="1.2" d="M4 1.75h5L12.5 5v8.25A1.25 1.25 0 0 1 11.25 14.5h-7.5A1.25 1.25 0 0 1 2.5 13.25v-10A1.25 1.25 0 0 1 3.75 2H4Zm5 0V5h3.5" />
    </svg>
  );
}

export function FileExplorer({ projectId, selectedPath, refreshKey = 0, refreshPath = null, onSelect }: FileExplorerProps) {
  const [state, setState] = useState<TreeState>(initialState);
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const refreshPathRef = useRef(refreshPath);
  refreshPathRef.current = refreshPath;

  const load = useCallback(
    async (path: string) => {
      if (inFlight.current.has(path)) return;
      inFlight.current.add(path);
      const requestGeneration = generation.current;
      setState((prev) => {
        const errors = new Map(prev.errors);
        errors.delete(path);
        return { ...prev, errors, loading: stateWith(prev.loading, path, true) };
      });
      try {
        const dto = await fileTree(projectId, path);
        if (generation.current !== requestGeneration || dto.projectId !== projectId) return;
        setState((prev) => {
          const nodes = new Map(prev.nodes);
          nodes.set(path, dto);
          return { ...prev, nodes, loading: stateWith(prev.loading, path, false) };
        });
      } catch (err) {
        if (generation.current !== requestGeneration) return;
        setState((prev) => {
          const errors = new Map(prev.errors);
          errors.set(path, err instanceof Error ? err.message : String(err));
          return { ...prev, errors, loading: stateWith(prev.loading, path, false) };
        });
      } finally {
        inFlight.current.delete(path);
      }
    },
    [projectId],
  );

  useEffect(() => {
    generation.current += 1;
    inFlight.current.clear();
    setState(initialState());
    void load('');
  }, [load]);

  useEffect(() => {
    if (refreshKey === 0) return;
    // Re-read the saved file's parent (and the root for its size badge) without losing which
    // folders the user has expanded.
    void load('');
    const parent = refreshPathRef.current === null ? '' : parentPath(refreshPathRef.current);
    if (parent !== '') void load(parent);
  }, [load, refreshKey]);

  const expand = useCallback(
    (path: string) => {
      setState((prev) => (prev.expanded.has(path) ? prev : { ...prev, expanded: stateWith(prev.expanded, path, true) }));
      if (!state.nodes.has(path)) void load(path);
    },
    [load, state.nodes],
  );

  useEffect(() => {
    if (selectedPath === null) return;
    const parts = selectedPath.split('/');
    let ancestor = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      ancestor = ancestor === '' ? parts[i]! : `${ancestor}/${parts[i]!}`;
      expand(ancestor);
    }
  }, [expand, selectedPath]);

  const collapse = useCallback((path: string) => {
    setState((prev) => ({ ...prev, expanded: stateWith(prev.expanded, path, false) }));
  }, []);

  const toggle = useCallback(
    (entry: FileTreeEntryDTO) => {
      if (entry.type !== 'dir') return;
      if (state.expanded.has(entry.path)) collapse(entry.path);
      else expand(entry.path);
    },
    [collapse, expand, state.expanded],
  );

  const root = state.nodes.get('');
  const rows = useMemo(() => root?.entries ?? [], [root]);

  return (
    <aside data-testid="file-explorer" aria-label="File explorer" className="flex h-full w-60 shrink-0 flex-col border-r border-glass-border bg-surface/50">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted-2 uppercase">Explorer</h2>
        <button
          type="button"
          data-testid="file-explorer-refresh"
          aria-label="Refresh file list"
          title="Refresh file list"
          onClick={() => {
            void load('');
            for (const path of state.expanded) void load(path);
          }}
          className="rounded px-1 text-[11px] text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        >
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        {root === undefined && state.loading.has('') && <p className="px-2 py-1 text-xs text-muted">Loading files…</p>}
        {state.errors.get('') && (
          <div className="px-2 py-1 text-xs text-danger-foreground" role="alert">
            {state.errors.get('')}
            <button type="button" className="ml-1 underline" onClick={() => void load('')}>Retry</button>
          </div>
        )}
        {root?.truncated && <p className="px-2 py-1 text-[11px] text-muted-2">Showing the first {root.entries.length} entries.</p>}
        <ul role="tree" aria-label="Repository files" className="space-y-0.5">
          {rows.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              depth={0}
              state={state}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={toggle}
              onLoad={load}
            />
          ))}
        </ul>
        {root && rows.length === 0 && <p className="px-2 py-1 text-xs text-muted">This folder is empty.</p>}
      </div>
    </aside>
  );
}

function TreeRow({
  entry,
  depth,
  state,
  selectedPath,
  onSelect,
  onToggle,
  onLoad,
}: {
  entry: FileTreeEntryDTO;
  depth: number;
  state: TreeState;
  selectedPath: string | null;
  onSelect(path: string): void;
  onToggle(entry: FileTreeEntryDTO): void;
  onLoad(path: string): void;
}) {
  const expanded = state.expanded.has(entry.path);
  const dir = state.nodes.get(entry.path);
  const loading = state.loading.has(entry.path);
  const error = state.errors.get(entry.path);
  const selected = selectedPath === entry.path;
  const testId = testIdForPath(entry.path);
  const isDir = entry.type === 'dir';

  const interactive = isDir || entry.type === 'file';

  return (
    <li
      role="treeitem"
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      aria-disabled={entry.type === 'symlink' ? true : undefined}
      aria-label={`${isDir ? 'Folder' : entry.type === 'symlink' ? 'Symlink' : 'File'} ${entry.name}`}
      data-testid={`file-row-${testId}`}
      tabIndex={interactive ? 0 : -1}
      title={entry.type === 'symlink' ? `${entry.path} (symlink, not followed)` : entry.path}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (isDir) onToggle(entry);
          else onSelect(entry.path);
          return;
        }
        if (!isDir) return;
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault();
          onToggle(entry);
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault();
          onToggle(entry);
        }
      }}
      className="w-full rounded-control focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      <div
        role="none"
        onClick={() => (isDir ? onToggle(entry) : entry.type === 'file' ? onSelect(entry.path) : undefined)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-control py-1 pr-2 text-left text-xs transition-colors',
          'hover:bg-surface-2',
          selected ? 'bg-accent-soft text-accent-soft-foreground' : 'text-foreground',
          entry.type === 'symlink' && 'cursor-not-allowed opacity-80 hover:bg-transparent',
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
      {isDir ? (
        <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('h-3 w-3 shrink-0 text-muted-2 transition-transform', expanded && 'rotate-90')}>
          <path fill="currentColor" d="M6 3.5 11 8l-5 4.5v-9Z" />
        </svg>
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <FileGlyph type={entry.type} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.type === 'symlink' && <span className="rounded bg-surface-2 px-1 text-[10px] text-muted-2">link</span>}
      {entry.size !== null && entry.size > 1024 && <span className="text-[10px] text-muted-2">{Math.ceil(entry.size / 1024)}k</span>}
      </div>
      {isDir && expanded && (
        <ul role="group" aria-label={`${entry.name} contents`} className="mt-0.5 space-y-0.5">
          {loading && <li className="py-1 text-[11px] text-muted-2" style={{ paddingLeft: `${12}px` }}>Loading…</li>}
          {error && (
            <li className="py-1 text-[11px] text-danger-foreground" style={{ paddingLeft: `${12}px` }} role="alert">
              {error}{' '}
              <button type="button" className="underline" onClick={() => onLoad(entry.path)}>Retry</button>
            </li>
          )}
          {dir && (
            <>
              {dir.truncated && <li className="py-1 text-[11px] text-muted-2" style={{ paddingLeft: `${12}px` }}>Showing the first {dir.entries.length} entries.</li>}
              {dir.entries.map((child) => (
                <TreeRow
                  key={child.path}
                  entry={child}
                  depth={depth + 1}
                  state={state}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onLoad={onLoad}
                />
              ))}
              {dir.entries.length === 0 && <li className="py-1 text-[11px] text-muted-2" style={{ paddingLeft: `${12}px` }}>Empty folder</li>}
            </>
          )}
        </ul>
      )}
    </li>
  );
}
