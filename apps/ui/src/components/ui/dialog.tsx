import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  // Radix restores focus to a Dialog.Trigger, but these dialogs are opened from
  // ordinary buttons, so remember the opener as the content mounts and return
  // focus to it when the content unmounts.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(4_7_16/0.70)] backdrop-blur-[3px]" />
        <DialogPrimitive.Content
          aria-label={title}
          onOpenAutoFocus={() => {
            restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus();
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2',
            'rounded-panel border border-glass-border bg-[rgb(16_20_36/0.92)] p-0 text-foreground shadow-panel backdrop-blur-[22px]',
          )}
        >
          <DialogPrimitive.Title className="border-b border-border bg-surface/40 px-5 py-3 text-base font-bold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          <div className="p-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
