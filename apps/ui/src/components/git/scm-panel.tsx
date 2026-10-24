// apps/ui/src/components/git/scm-panel.tsx
import type { GitFileDTO, GitStatusDTO } from '@aik/contracts';
import { useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../ui/button.tsx';
import { BranchDropdown } from './branch-dropdown.tsx';

const BADGE: Record<string, { cls: string; label: string }> = {
  M: { cls: 'bg-[rgb(59_130_246/0.25)] text-[#93c5fd]', label: 'M' },
  A: { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'A' },
  D: { cls: 'bg-[rgb(251_113_133/0.22)] text-[#fda4af]', label: 'D' },
  U: { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'U' },
  '?': { cls: 'bg-[rgb(16_185_129/0.22)] text-[#6ee7b7]', label: 'U' },
  R: { cls: 'bg-[rgb(139_92_246/0.22)] text-[#c4b5fd]', label: 'R' },
};

const tid = (p: string) => `git-file-${p.replace(/[^A-Za-z0-9-]/g, '_')}`;

function FileRow({ file, staged, onStage, onUnstage, onDiscard, busy }: {
  file: GitFileDTO; staged?: boolean; busy: boolean;
  onStage: (p: string) => void; onUnstage: (p: string) => void; onDiscard: (p: string) => void;
}) {
  const path = file.path.split('/').filter(Boolean).slice(0, -1).join('/');
  const name = file.path.split('/').pop() ?? file.path;
  const badge = BADGE[file.x === '?' ? '?' : staged ? file.x : file.y] ?? { cls: 'bg-surface-3 text-muted-2', label: staged ? file.x : file.y };
  return (
    <li className="flex items-center gap-2 border-t border-border px-2 py-1 font-mono text-xs first:border-t-0" data-testid={tid(file.path)}>
      {staged ? (
        <button type="button" aria-label={`Unstage ${name}`} className="text-muted-2 hover:text-accent-soft-foreground" disabled={busy} onClick={() => onUnstage(file.path)}>−</button>
      ) : (
        <>
          <button type="button" aria-label={`Stage ${name}`} className="text-muted-2 hover:text-accent-soft-foreground" disabled={busy} onClick={() => onStage(file.path)}>+</button>
          <button type="button" aria-label={`Discard changes in ${name}`} className="text-muted-2 hover:text-danger-foreground" disabled={busy} onClick={() => onDiscard(file.path)}>↺</button>
        </>
      )}
      <span className="truncate" title={file.path}>
        {path && <span className="text-muted-2">{path}/ </span>}
        <span>{name}</span>
      </span>
      <span className={cn('ml-auto grid h-4 w-4 place-items-center rounded-[5px] text-[10px] font-bold', badge.cls)}>{badge.label}</span>
    </li>
  );
}

export interface ScmPanelProps {
  status: GitStatusDTO;
  branches: { local: string[]; remote: string[] };
  busy: boolean; // mutation in flight locally
  onStage: (paths?: string[]) => Promise<void>;
  onUnstage: (paths?: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onDiscard: (path: string) => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onPush: () => Promise<void>;
  onPull: () => Promise<void>;
  syncBusy: boolean;
}

export function ScmPanel({ status, branches, busy, onStage, onUnstage, onCommit, onDiscard, onCheckout, onCreate, onPush, onPull, syncBusy }: ScmPanelProps) {
  const [message, setMessage] = useState('');
  const noRemote = status.upstream === null;
  const dirtySwitch = status.staged.length + status.changes.length > 0;
  const locked = status.agentBusy || syncBusy || status.mergeState !== 'none';
  const canCommit = !locked && !busy && status.staged.length > 0 && message.trim() !== '';

  // Await the commit before clearing so a failed commit keeps the typed message.
  const commit = async () => {
    const m = message.trim();
    if (m === '') return;
    try {
      await onCommit(m);
      setMessage('');
    } catch {
      // Parent surfaces the failure via its error state; keep the text.
    }
  };

  return (
    <section className="flex min-h-0 w-80 shrink-0 flex-col gap-2 border-r border-border bg-glass p-3">
      <div className="flex items-center gap-2">
        <BranchDropdown current={status.branch} local={branches.local} remote={branches.remote} disabled={locked || busy || dirtySwitch} onCheckout={onCheckout} onCreate={onCreate} />
        <Button size="sm" data-testid="git-push" className="ml-auto" disabled={locked || busy || noRemote} title={noRemote ? 'No remote configured' : `Push ${status.ahead ?? 0}`} onClick={() => void onPush()}>
          Push{status.ahead ? ` ↑${status.ahead}` : ''}
        </Button>
        <Button size="sm" data-testid="git-pull" disabled={locked || busy || noRemote || dirtySwitch} title={dirtySwitch ? 'Stage your changes first' : noRemote ? 'No remote configured' : `Pull ${status.behind ?? 0}`} onClick={() => void onPull()}>
          Pull{status.behind ? ` ↓${status.behind}` : ''}
        </Button>
      </div>

      {status.agentBusy && (
        <p data-testid="git-agent-busy" role="status" className="rounded-control border border-warning/35 bg-warning/10 px-2 py-1 text-xs text-warning-foreground">
          ● Agent run in progress — Git actions paused
        </p>
      )}
      {status.mergeState !== 'none' && (
        <p role="alert" className="rounded-control border border-danger/35 bg-danger/10 px-2 py-1 text-xs text-danger-foreground">
          A merge/rebase is in progress — resolve it in your terminal, then commit there.
        </p>
      )}
      {dirtySwitch && (
        <p className="text-[11px] text-muted-2">Switching branches/pulling pauses until your changes are committed or discarded.</p>
      )}

      <textarea
        data-testid="git-commit-input"
        className="min-h-16 rounded-control border border-border bg-black/25 px-2.5 py-2 text-xs"
        placeholder={status.staged.length > 0 ? 'Message (Ctrl+Enter to commit)' : 'Stage changes to enable commit'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void commit();
        }}
        disabled={locked}
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" data-testid="git-commit" disabled={!canCommit} onClick={() => void commit()}>Commit</Button>
      </div>

      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-2">Staged Changes ({status.staged.length})</p>
      <ul data-testid="git-staged-group" className="rounded-panel border border-border bg-surface/50">
        {status.staged.map((f) => (
          <FileRow key={f.path} file={f} staged busy={locked || busy} onStage={(p) => void onStage([p])} onUnstage={(p) => void onUnstage([p])} onDiscard={onDiscard} />
        ))}
        {status.staged.length === 0 && <li className="px-2 py-1 text-xs text-muted-2">Empty</li>}
      </ul>

      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-2">Changes ({status.changes.length})</p>
      <ul data-testid="git-changes-group" className="rounded-panel border border-border bg-surface/50">
        {status.changes.map((f) => (
          <FileRow key={f.path} file={f} busy={locked || busy} onStage={(p) => void onStage([p])} onUnstage={(p) => void onUnstage([p])} onDiscard={onDiscard} />
        ))}
        {status.changes.length === 0 && <li className="px-2 py-1 text-xs text-muted-2">Clean tree</li>}
      </ul>

      <p className="mt-auto text-[11px] text-muted-2">Discarding a file asks for confirmation; discarding an untracked file deletes it.</p>
    </section>
  );
}
