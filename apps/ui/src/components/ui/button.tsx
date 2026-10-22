import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.ts';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-control font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-br from-accent to-accent-2 text-accent-foreground shadow-[0_6px_16px_-6px_rgb(109_94_252/0.85)] hover:brightness-110',
        secondary:
          'border border-border bg-surface-2 text-foreground hover:bg-surface-3 hover:border-border-strong',
        danger:
          'border border-danger/40 bg-danger/15 text-danger-foreground hover:bg-danger/25',
        ghost: 'text-muted hover:bg-surface-2 hover:text-foreground',
      },
      size: {
        sm: 'px-2.5 py-1 text-xs',
        md: 'px-3 py-1.5 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ variant, size, className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
