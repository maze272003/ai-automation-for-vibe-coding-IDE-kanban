import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full appearance-none rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
