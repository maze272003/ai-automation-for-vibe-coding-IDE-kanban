import { useState } from 'react';
import { TopBar } from '../components/shell/top-bar.tsx';
import { useOffice } from '../office3d/state/use-office.ts';
import { QuickJumpPanel } from '../office3d/ui/QuickJumpPanel.tsx';

/** The 3D office shell: the canvas (Task 16) on the left, the live room list on the right. */
export function OfficePage() {
  const { state, now, ready, error } = useOffice();
  const [, setSelectedRoom] = useState<number | null>(null);
  const hasProjects = [...state.rooms.values()].some((r) => r.state === 'active');

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Office" subtitle="Every project has its own suite" />
      <div className="min-h-0 flex-1 p-4">
        {!ready ? (
          <p data-testid="office-loading" className="text-sm text-muted">
            {error ?? 'Loading…'}
          </p>
        ) : (
          <div className="flex h-full gap-4">
            <div className="min-w-0 flex-1">
              {hasProjects ? (
                <div data-testid="office-canvas" className="h-full w-full rounded-panel border border-glass-border bg-surface-2" />
              ) : (
                <p data-testid="office-empty" className="rounded-panel border border-dashed border-glass-border bg-glass/40 p-6 text-sm text-muted">
                  Import a project to open its office suite.
                </p>
              )}
            </div>
            <QuickJumpPanel state={state} now={now} onSelectRoom={setSelectedRoom} />
          </div>
        )}
      </div>
    </div>
  );
}
