import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

export function Skeleton({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} {...props} />;
}
