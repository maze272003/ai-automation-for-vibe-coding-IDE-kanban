import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

export function TooltipContent({ className = '', sideOffset = 6, ...props }: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-control border border-glass-border bg-surface-3 px-2 py-1 text-xs text-foreground shadow-panel backdrop-blur-[18px] dark:bg-[rgb(18_22_38/0.96)]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * One-line tooltip: wraps its child as the trigger and shows `label` on hover and
 * keyboard focus. It carries its own provider so it works anywhere, including
 * outside an app-level `TooltipProvider`.
 */
export function Tooltip({ label, children, side = 'top' }: TooltipProps) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root>
        {isValidElement(children) ? (
          <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        ) : (
          <TooltipPrimitive.Trigger>{children}</TooltipPrimitive.Trigger>
        )}
        <TooltipContent side={side}>{label}</TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  );
}
