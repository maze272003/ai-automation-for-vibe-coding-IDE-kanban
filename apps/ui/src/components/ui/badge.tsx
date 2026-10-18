import type { HTMLAttributes } from 'react';

type Tone = 'default' | 'muted' | 'warn' | 'danger' | 'ok';
const TONES: Record<Tone, string> = {
  default: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200',
  muted: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  danger: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
};

export function Badge({ tone = 'default', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`} {...props} />;
}
