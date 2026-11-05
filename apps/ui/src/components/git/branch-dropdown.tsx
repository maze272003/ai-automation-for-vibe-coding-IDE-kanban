// apps/ui/src/components/git/branch-dropdown.tsx
import { useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../ui/button.tsx';

export interface BranchDropdownProps {
  current: string | null;
  local: string[];
  remote: string[];
  disabled: boolean;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}

/** VS Code-style branch menu: search, locals with ✓, remotes, create-new. */
export function BranchDropdown({ current, local, remote, disabled, onCheckout, onCreate }: BranchDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  const match = (b: string) => b.toLowerCase().includes(query.toLowerCase());

  const choose = async (name: string) => {
    setOpen(false);
    setQuery('');
    await onCheckout(name);
  };
  const create = async () => {
    if (!creating) return;
    setOpen(false);
    setCreating(null);
    await onCreate(creating);
  };

  return (
    <div className="relative" data-testid="git-branch-dropdown">
      <Button
        size="sm"
        data-testid="git-branch-button"
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
        aria-expanded={open}
      >
        ⎇ {current ?? 'no branch'} ▾
      </Button>
      {open && (
        <div className="absolute left-0 top-8 z-40 w-64 rounded-panel border border-border-strong bg-overlay-fill p-2 shadow-panel">
          <input
            className="w-full rounded-control border border-border bg-surface-3 px-2 py-1 text-xs"
            placeholder="Search branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">Local</p>
          <div className="max-h-48 overflow-y-auto">
            {local.filter(match).map((b) => (
              <button
                key={b}
                type="button"
                className={cn('flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-xs font-semibold hover:bg-surface-2', b === current && 'bg-accent-soft text-accent-soft-foreground')}
                onClick={() => void choose(b)}
              >
                <span className="w-3">{b === current ? '✓' : ''}</span>
                {b}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-muted-2">Remote</p>
          <div className="max-h-32 overflow-y-auto">
            {remote.filter(match).map((b) => (
              <p key={b} className="px-2 py-1 text-xs text-muted-2">
                {b}
              </p>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-xs font-semibold">
            ＋ New branch
            <input className="flex-1 rounded-control border border-border bg-surface-3 px-2 py-1 text-xs" value={creating ?? ''} onChange={(e) => setCreating(e.target.value)} />
            <Button size="sm" variant="primary" disabled={!creating} onClick={() => void create()}>Create</Button>
          </label>
        </div>
      )}
    </div>
  );
}
