// apps/ui/src/components/shell/sidebar.tsx
import type { ProjectDTO } from '@aik/contracts';
import { Link } from '@tanstack/react-router';
import { cn } from '../../lib/cn.ts';
import { StatusCard } from './status-card.tsx';

export interface SidebarProps {
  projects: ProjectDTO[];
  orchestratorState: string;
  dataDir: string | null;
}

const navItem =
  'rounded-control px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function Sidebar({ projects, orchestratorState, dataDir }: SidebarProps) {
  return (
    <aside
      data-testid="app-sidebar"
      className="flex w-[212px] shrink-0 flex-col gap-3 border-r border-border bg-surface p-3 backdrop-blur-[14px]"
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <span
          aria-hidden="true"
          className="h-5 w-5 rounded-[7px] bg-gradient-to-br from-[#a78bfa] via-[#6366f1] to-[#22d3ee] shadow-[0_0_0_3px_rgb(139_92_246/0.2)]"
        />
        <span className="block">
          <span className="block text-sm font-bold tracking-tight text-foreground">AI Kanban</span>
          <span className="block text-[10px] text-muted-2">desktop</span>
        </span>
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <Link to="/" className={navItem}>
          Projects
        </Link>
        <Link to="/settings" className={navItem}>
          Settings
        </Link>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-1 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-2">
          Your projects
        </p>
        {/*
          E2/E3: the accessible name is "Open <name>", never "<KEY> · <name>" —
          the dashboard card owns that exact name and Playwright fails on two
          matches. The visible text still reads "<KEY> · <name>".
          E4: the list is `sidebar-project-list`; `project-list` belongs to the
          dashboard grid and must exist exactly once in the app.
        */}
        <ul data-testid="sidebar-project-list" className="flex flex-col gap-0.5">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: String(p.id) }}
                aria-label={`Open ${p.name}`}
                className={cn(
                  'flex items-center gap-2 rounded-control px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                )}
              >
                <span className="rounded-[5px] border border-accent/25 bg-accent-soft px-1 py-px font-mono text-[10px] font-bold text-accent-soft-foreground">
                  {p.key}
                </span>
                <span className="truncate">{` · ${p.name}`}</span>
                {p.status === 'unavailable' && (
                  <span aria-label="unavailable" className="ml-auto h-1.5 w-1.5 rounded-full bg-warning" />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <StatusCard state={orchestratorState} dataDir={dataDir} />
    </aside>
  );
}
