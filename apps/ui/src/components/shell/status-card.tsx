// apps/ui/src/components/shell/status-card.tsx
import { cn } from '../../lib/cn.ts';

/** The orchestrator's live state, pinned to the bottom of the sidebar. */
export function StatusCard({ state, dataDir }: { state: string; dataDir: string | null }) {
  const ready = state === 'ready';
  return (
    <div data-testid="orchestrator-card" className="rounded-card border border-border bg-surface-3 p-3">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 rounded-full', ready ? 'bg-success shadow-[0_0_8px_var(--success)]' : 'bg-warning')}
        />
        <span className={cn('text-xs font-semibold', ready ? 'text-success-foreground' : 'text-warning-foreground')}>
          orchestrator {state}
        </span>
      </div>
      {dataDir && (
        <p className="mt-1.5 truncate font-mono text-[10px] text-muted-2" title={dataDir}>
          {dataDir}
        </p>
      )}
    </div>
  );
}
