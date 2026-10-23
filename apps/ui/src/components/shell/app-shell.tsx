// apps/ui/src/components/shell/app-shell.tsx
import type { ProjectDTO } from '@aik/contracts';
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar.tsx';

export interface AppShellProps {
  projects: ProjectDTO[];
  orchestratorState: string;
  dataDir: string | null;
  children: ReactNode;
}

/**
 * Sidebar + content region. The chrome is fixed; only the content region scrolls.
 *
 * Deliberately no opaque background here: the fixed aurora wash lives on
 * `body::before` (`z-index: -1`) and has to show through the glass surfaces.
 * Painting `bg-background` on this root would hide the canvas completely.
 */
export function AppShell({ projects, orchestratorState, dataDir, children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden text-foreground">
      <Sidebar projects={projects} orchestratorState={orchestratorState} dataDir={dataDir} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
