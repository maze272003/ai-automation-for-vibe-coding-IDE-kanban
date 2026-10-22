import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Separator({
  orientation = 'horizontal',
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
