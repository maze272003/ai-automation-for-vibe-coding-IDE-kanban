import type { SystemState } from '@aik/contracts';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
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
    <div data-testid="system-failure" role="alert" className="m-4 rounded-md border border-red-400 bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100">
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

export function RootLayout() {
  const system = useSystemState();
  const [health, setHealth] = useState<Health | null>(null);
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

  return (
    <ToastProvider>
      <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <span className="font-semibold">AI Kanban</span>
          <nav className="flex gap-3 text-sm">
            <Link to="/" className="hover:underline">Projects</Link>
            <Link to="/settings" className="hover:underline">Settings</Link>
          </nav>
          <span className="ml-auto text-xs text-zinc-500" aria-label="Orchestrator status">orchestrator: {system.state}</span>
        </header>
        {(system.state === 'fatal' || system.state === 'crash-loop') && <SystemFailure system={system} />}
        {health && <div data-testid="app-ready" hidden />}
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
