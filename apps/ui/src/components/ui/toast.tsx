import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

type Tone = 'info' | 'error';
type Toast = { id: number; message: string; tone: Tone };
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[90vw] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto rounded-card border bg-[rgb(18_22_38/0.94)] p-3 shadow-panel backdrop-blur-[18px]',
              t.tone === 'error' ? 'border-danger/40' : 'border-glass-border',
            )}
          >
            <div className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-px grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-[10px] font-bold',
                  t.tone === 'error'
                    ? 'border-danger/35 bg-danger/15 text-danger-foreground'
                    : 'border-success/35 bg-success/15 text-success-foreground',
                )}
              >
                {t.tone === 'error' ? '!' : '✓'}
              </span>
              <p className="text-xs leading-relaxed text-foreground">{t.message}</p>
            </div>
            <div
              aria-hidden="true"
              className={cn(
                'mt-2 h-0.5 rounded-full bg-gradient-to-r to-transparent',
                t.tone === 'error' ? 'from-danger' : 'from-accent',
              )}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
