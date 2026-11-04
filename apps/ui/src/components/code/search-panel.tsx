// apps/ui/src/components/code/search-panel.tsx
import type { FileSearchDTO, FileSearchMatchDTO } from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { formatMatchLocation, searchFiles, searchPreview } from '../../lib/files.ts';

export interface SearchPanelProps {
  projectId: number;
  open: boolean;
  onClose(): void;
  onOpenMatch(match: FileSearchMatchDTO): void;
}

const CASE_KEY = 'aik.search.case';
const DEBOUNCE_MS = 250;

function storedCaseSensitivity(): boolean {
  try {
    return sessionStorage.getItem(CASE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function SearchPanel({ projectId, open, onClose, onOpenMatch }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(storedCaseSensitivity);
  const [result, setResult] = useState<FileSearchDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const trimmed = query.trim();

  useEffect(() => {
    if (!open) {
      // Invalidate an in-flight walk when the panel closes.
      request.current += 1;
      setLoading(false);
      return;
    }
    if (trimmed === '') {
      request.current += 1;
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const id = request.current + 1;
    request.current = id;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void searchFiles(projectId, trimmed, caseSensitive).then(
        (next) => {
          if (request.current !== id) return;
          setResult(next);
          setLoading(false);
        },
        (err: unknown) => {
          if (request.current !== id) return;
          setResult(null);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [caseSensitive, open, projectId, trimmed]);

  const closePanel = () => {
    onClose();
    document.querySelector<HTMLElement>('[data-testid="code-search-toggle"]')?.focus();
  };

  const toggleCase = () => {
    setCaseSensitive((value) => {
      const next = !value;
      try {
        sessionStorage.setItem(CASE_KEY, String(next));
      } catch {
        /* session storage unavailable: keep the choice in memory */
      }
      return next;
    });
  };

  if (!open) return null;

  return (
    <aside
      data-testid="search-panel"
      aria-label="Search across files"
      className="flex h-full w-80 shrink-0 flex-col border-l border-glass-border bg-surface/50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') closePanel();
      }}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted-2 uppercase">Search</h2>
        <button type="button" onClick={closePanel} aria-label="Close search" className="rounded px-1 text-xs text-muted hover:text-foreground">×</button>
      </div>
      <div className="flex items-center gap-1 px-3 pb-2">
        <input
          ref={input}
          data-testid="code-search-input"
          aria-label="Search text"
          aria-controls="code-search-results"
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find in files…"
          className="min-w-0 flex-1 rounded-control border border-border bg-surface-2 px-2 py-1 text-xs text-foreground placeholder:text-muted-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        />
        <button
          type="button"
          data-testid="code-search-case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={toggleCase}
          className={cn(
            'rounded-control border px-1.5 py-1 text-[11px] font-semibold',
            caseSensitive ? 'border-accent/40 bg-accent-soft text-accent-soft-foreground' : 'border-border bg-surface-2 text-muted hover:text-foreground',
          )}
        >
          Aa
        </button>
      </div>
      <div id="code-search-results" aria-busy={loading} className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {loading && <p role="status" className="px-1 py-1 text-xs text-muted">Searching…</p>}
        {error && <p role="alert" data-testid="code-search-error" className="px-1 py-1 text-xs text-danger-foreground">{error}</p>}
        {!loading && !error && result && (
          <>
            <p role="status" aria-live="polite" className="px-1 py-1 text-[11px] text-muted-2">
              {result.matches.length} match{result.matches.length === 1 ? '' : 'es'} in {result.filesScanned} file{result.filesScanned === 1 ? '' : 's'}
              {result.truncated && result.matches.length > 0 ? ` · showing the first ${result.matches.length} matches` : ''}
            </p>
            {result.matches.length === 0 && result.truncated && (
              <p className="px-1 py-1 text-xs text-muted">
                Scanned {result.filesScanned} files and stopped at the scan limit before finding a match. Narrow the query.
              </p>
            )}
            {result.matches.length === 0 && !result.truncated && <p className="px-1 py-1 text-xs text-muted">No matches.</p>}
            <ul className="space-y-0.5">
              {result.matches.map((match, index) => (
                <li key={`${match.path}:${match.line}:${match.column}`}>
                  <button
                    type="button"
                    data-testid={`search-result-${index}`}
                    onClick={() => onOpenMatch(match)}
                    className="w-full rounded-control px-1.5 py-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  >
                    <span className="block truncate font-mono text-[10px] text-muted-2">{formatMatchLocation(match.path, match.line, match.column)}</span>
                    <span className="block truncate text-xs text-foreground">{searchPreview(match.preview)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {!loading && !error && !result && trimmed === '' && <p className="px-1 py-1 text-xs text-muted">Type to search every text file in this repository.</p>}
      </div>
    </aside>
  );
}
