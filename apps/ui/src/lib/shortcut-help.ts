// apps/ui/src/lib/shortcut-help.ts — tiny custom-event channel for opening the
// shortcut reference without prop drilling. Deliberately React-free so routes,
// settings and the sidebar can call it from anywhere.

export const SHORTCUT_HELP_EVENT = 'aik:shortcuts-help';

/** Asks the host (RootLayout) to open the shortcut reference. No-op without a window. */
export function openShortcutHelp(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SHORTCUT_HELP_EVENT));
}

/** Subscribes to shortcut-help requests; returns an unsubscribe function. */
export function subscribeShortcutHelp(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = () => callback();
  window.addEventListener(SHORTCUT_HELP_EVENT, listener);
  return () => window.removeEventListener(SHORTCUT_HELP_EVENT, listener);
}
