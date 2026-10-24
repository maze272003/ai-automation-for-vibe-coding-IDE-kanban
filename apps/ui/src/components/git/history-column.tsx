// apps/ui/src/components/git/history-column.tsx
import type { CommitFilesDTO, CommitLogDTO } from '@aik/contracts';
import { useState } from 'react';
import { ApiRequestError } from '../../lib/api.ts';

const short = (dateIso: string) => new Date(dateIso).toLocaleString();

export function HistoryColumn({ log, openFiles }: { log: CommitLogDTO | null; openFiles: (sha: string) => Promise<CommitFilesDTO> }) {
  const [open, setOpen] = useState<Record<string, CommitFilesDTO>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const clear = (sha: string) => {
    setFailed((f) => { if (!(sha in f)) return f; const next = { ...f }; delete next[sha]; return next; });
  };
  const toggle = async (sha: string) => {
    if (open[sha]) {
      setOpen((o) => { const next = { ...o }; delete next[sha]; return next; });
      clear(sha);
      return;
    }
    // Optimistic placeholder keeps the row expanded while the file list loads.
    setOpen((o) => ({ ...o, [sha]: { projectId: 0, sha: '', files: [] } }));
    clear(sha);
    try {
      const files = await openFiles(sha);
      setOpen((o) => ({ ...o, [sha]: files }));
    } catch (err) {
      // Roll back the optimistic placeholder so no misleading empty row remains.
      setOpen((o) => { const next = { ...o }; delete next[sha]; return next; });
      setFailed((f) => ({ ...f, [sha]: err instanceof ApiRequestError ? err.reason : err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="git-history">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">History</p>
      {(log?.commits ?? []).map((c) => (
        <article key={c.sha} className="mb-2 rounded-panel border border-border bg-surface/60 p-3">
          <button type="button" className="block w-full text-left" onClick={() => void toggle(c.sha)}>
            <p className="text-xs font-bold">{c.subject}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-2">{c.short} · {c.author} · {short(c.dateIso)}{c.parents.length > 1 ? ' · merge' : ''}</p>
          </button>
          {open[c.sha] && (
            <ul className="mt-2 border-t border-dashed border-border pt-2 font-mono text-[11px]">
              {open[c.sha]!.files.map((f) => (
                <li key={f.path} className="text-muted">{f.change} {f.path}</li>
              ))}
              {open[c.sha]!.files.length === 0 && <li className="text-muted-2">root commit / merge — no file list</li>}
            </ul>
          )}
          {failed[c.sha] && (
            <p role="alert" className="mt-2 text-[11px] text-danger-foreground">
              Could not load files for {c.short}: {failed[c.sha]}
            </p>
          )}
        </article>
      ))}
      {log && log.commits.length === 0 && <p className="text-xs text-muted-2">No commits yet.</p>}
    </section>
  );
}
