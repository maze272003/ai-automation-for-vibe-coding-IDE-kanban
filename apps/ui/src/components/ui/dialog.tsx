import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className="m-auto rounded-lg bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="w-[32rem] max-w-[90vw] p-5">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
