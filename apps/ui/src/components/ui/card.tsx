import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative rounded-panel border border-glass-border bg-glass shadow-card',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-white/10',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4 pb-2', className)} {...props} />;
}

export function CardTitle({ className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold text-foreground', className)} {...props} />;
}

export function CardDescription({ className = '', ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs text-muted', className)} {...props} />;
}

export function CardContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-2', className)} {...props} />;
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-4 pt-2', className)} {...props} />;
}
