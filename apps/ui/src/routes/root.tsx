import type { ProjectDTO, SystemState } from '@aik/contracts';
import { Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppShell } from '../components/shell/app-shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { ToastProvider } from '../components/ui/toast.tsx';
import { api } from '../lib/api.ts';
import { useSystemState } from '../lib/events.ts';

export interface Health {
  status: string;
  versions: { app: string; electron: string | null; node: string; opencode: string | null };
  components: { db: string };
  dataDir: string;
}

function SystemFailure({ system }: { system: SystemState }) {
  const [note, setNote] = useState<string | null>(null);
  const corrupt = system.state === 'fatal' && system.fatal?.kind === 'database_corrupt';
  return (
    <div
      data-testid="system-failure"
      role="alert"
      className="m-4 rounded-card border border-danger/40 bg-danger/10 p-4 text-danger-foreground"
    >
      {system.state === 'crash-loop' ? (
        <>
          <p className="font-semibold">The orchestrator keeps crashing.</p>
          <p className="text-sm">See logs\orchestrator.log and logs\orchestrator-stdio.log in the data folder.</p>
          <Button className="mt-2" onClick={() => void window.api.restartOrchestrator()}>Try again</Button>
        </>
      ) : (
        <>
          <p className="font-semibold">The orchestrator could not start.</p>
          <p className="text-sm">{system.fatal?.message}</p>
          {corrupt && (
            <Button
              className="mt-2"
              variant="primary"
              onClick={async () => {
                const r = await window.api.restoreLatestBackup();
                setNote(r.ok ? `Restored ${r.restoredFrom}` : r.reason);
              }}
            >
              Restore latest backup
            </Button>
          )}
          {note && <p className="mt-2 text-sm">{note}</p>}
        </>
      )}
    </div>
  );
}

function sameProjects(a: ProjectDTO[], b: ProjectDTO[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const n = b[i];
      return n !== undefined && p.id === n.id && p.key === n.key && p.name === n.name && p.status === n.status;
    })
  );
}

export function RootLayout() {
  const system = useSystemState();
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<ProjectDTO[]>([]);

  useEffect(() => {
    if (system.state !== 'ready') return;
    let alive = true;
    api.get<Health>('/health').then(
      (h) => alive && setHealth(h),
      () => alive && setHealth(null),
    );
    return () => {
      alive = false;
    };
  }, [system.state]);

  useEffect(() => {
    if (system.state !== 'ready') return;
    let alive = true;
    const load = () =>
      api.get<ProjectDTO[]>('/projects').then(
        (next) => {
          if (!alive) return;
          // Keep the previous array when nothing changed so the poll does not
          // re-render the whole route tree (and the board's 200 cards) every tick.
          setProjects((prev) => (sameProjects(prev, next) ? prev : next));
        },
        () => {
          if (alive) setProjects((prev) => (prev.length === 0 ? prev : []));
        },
      );
    void load();
    // Projects are created on the dashboard, which owns its own list, and the
    // event bus has no project topic — so the sidebar refreshes on a short poll
    // instead of going stale after the first paint.
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [system.state]);

  return (
    <ToastProvider>
      <AppShell projects={projects} orchestratorState={system.state} dataDir={health?.dataDir ?? null}>
        {(system.state === 'fatal' || system.state === 'crash-loop') && <SystemFailure system={system} />}
        {health && <div data-testid="app-ready" hidden />}
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </AppShell>
    </ToastProvider>
  );
}
