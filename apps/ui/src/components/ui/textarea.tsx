import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full min-h-20 rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-sm text-foreground',
        'placeholder:text-muted-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
