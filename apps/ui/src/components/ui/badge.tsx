import type { HTMLAttributes } from 'react';
import type { Priority, StoryStatus } from '@aik/contracts';
import { cn } from '../../lib/cn.ts';
import { PRIORITY_THEME, STATUS_THEME } from '../../lib/status-theme.ts';

type Tone = 'default' | 'muted' | 'warn' | 'danger' | 'ok' | 'status';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Renders the badge in the status colour when `tone="status"`. */
  status?: StoryStatus;
  /** Renders the badge in the priority colour when set. */
  priority?: Priority;
}

const TONES: Record<Exclude<Tone, 'status'>, string> = {
  default: 'bg-accent/15 text-accent-foreground',
  muted: 'bg-surface-3 text-muted',
  warn: 'bg-warning/15 text-warning-foreground',
  danger: 'bg-danger/15 text-danger-foreground',
  ok: 'bg-success/15 text-success-foreground',
};

export function Badge({ tone = 'default', status, priority, className = '', style, children, ...props }: BadgeProps) {
  const priorityTheme = priority ? PRIORITY_THEME[priority] : null;
  const statusTheme = status ? STATUS_THEME[status] : null;
  const base = cn(
    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold leading-none',
    className,
  );
  if (priorityTheme) {
    return (
      <span className={base} style={{ background: priorityTheme.softBg, color: priorityTheme.softFg, ...style }} {...props}>
        {priorityTheme.label}
      </span>
    );
  }
  if (statusTheme) {
    return (
      <span className={base} style={{ background: statusTheme.softBg, color: statusTheme.softFg, ...style }} {...props}>
        {statusTheme.label}
      </span>
    );
  }
  // `tone="status"` without a status prop falls back to the default tone.
  const toneClass = TONES[tone === 'status' ? 'default' : tone];
  return (
    <span className={cn(base, toneClass)} style={style} {...props}>
      {children}
    </span>
  );
}
