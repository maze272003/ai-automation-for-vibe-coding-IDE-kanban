// apps/ui/src/lib/cn.ts — class-name merging: clsx flattens conditionals, tailwind-merge resolves conflicts.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
