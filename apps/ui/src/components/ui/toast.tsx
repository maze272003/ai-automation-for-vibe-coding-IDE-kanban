import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

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
      <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-md px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-800 text-white'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
