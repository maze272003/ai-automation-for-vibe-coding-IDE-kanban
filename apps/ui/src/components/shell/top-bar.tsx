// apps/ui/src/components/shell/top-bar.tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string;
  subtitle?: string;
}

/**
 * The glass page header. Each route renders its own — the board puts its search,
 * filters and "New story" in `children`; the dashboard and settings put nothing.
 * There is deliberately no decorative search field: a ⌘K affordance that does
 * nothing is worse than none, and the board already owns a real one.
 */
export function TopBar({ title, subtitle, className = '', children, ...props }: TopBarProps) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-center gap-2.5 border-b border-border bg-surface/60 px-4 py-2.5 backdrop-blur-[12px]',
        className,
      )}
      {...props}
    >
      <h1 className="text-base font-bold tracking-tight text-foreground">{title}</h1>
      {/* The subtitle sits beside the h1, not inside it, so the heading's
          accessible name stays exactly `title` (dashboard.spec.ts E5). */}
      {subtitle && <span className="-ml-1 text-xs font-medium text-muted-2">{subtitle}</span>}
      {children}
    </header>
  );
}
