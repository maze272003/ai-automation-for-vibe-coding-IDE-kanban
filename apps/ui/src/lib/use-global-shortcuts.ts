// apps/ui/src/lib/use-global-shortcuts.ts — one StrictMode-safe window listener
// for the registry's global bindings. Navigation itself stays in the host
// (RootLayout) via the handler map; this hook only matches, guards and dispatches.

import { useEffect, useRef } from 'react';
import {
  GLOBAL_SHORTCUTS,
  detectPlatform,
  isEditableTarget,
  isModalOpen,
  matchesShortcut,
  type Platform,
  type ShortcutId,
  type ShortcutKeyboardEvent,
} from './shortcuts.ts';

export type GlobalShortcutId =
  | 'nav.projects'
  | 'nav.usage'
  | 'nav.office'
  | 'nav.settings'
  | 'nav.diagnostics'
  | 'view.theme'
  | 'help.shortcuts';

export type GlobalShortcutHandlers = Partial<Record<GlobalShortcutId, () => void>>;

export interface GlobalShortcutEvent extends ShortcutKeyboardEvent {
  target?: unknown;
  defaultPrevented?: boolean;
  repeat?: boolean;
  preventDefault?: () => void;
}

export interface ShortcutDispatchEnv {
  platform?: Platform;
  isEditable?: (target: unknown) => boolean;
  isModalOpen?: () => boolean;
}

const isGlobalShortcutId = (id: ShortcutId): id is GlobalShortcutId =>
  GLOBAL_SHORTCUTS.some((shortcut) => shortcut.id === id);

/**
 * Pure dispatch used by the hook and by unit tests: suppresses default-prevented
 * repeats, editable targets and any open dialog for *every* binding (including
 * F1), then fires the first matching global binding with a handler. Only a
 * matched binding with a handler calls preventDefault().
 */
export function dispatchGlobalShortcut(
  event: GlobalShortcutEvent,
  handlers: GlobalShortcutHandlers,
  env: ShortcutDispatchEnv = {},
): GlobalShortcutId | null {
  if (event.defaultPrevented || event.repeat) return null;
  const editable = env.isEditable ?? isEditableTarget;
  if (editable(event.target)) return null;
  const modalOpen = env.isModalOpen ?? isModalOpen;
  if (modalOpen()) return null;

  const platform = env.platform ?? detectPlatform();
  for (const shortcut of GLOBAL_SHORTCUTS) {
    if (!matchesShortcut(event, shortcut.chord, platform)) continue;
    if (!isGlobalShortcutId(shortcut.id)) continue;
    const handler = handlers[shortcut.id];
    if (!handler) return null;
    event.preventDefault?.();
    handler();
    return shortcut.id;
  }
  return null;
}

/**
 * Installs one stable keydown listener. The handler map lives in a ref so prop
 * churn never re-subscribes (React StrictMode's mount/unmount cycle therefore
 * cannot double-fire) while the latest callbacks are always used.
 */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers): void {
  const handlerRef = useRef(handlers);
  handlerRef.current = handlers;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      dispatchGlobalShortcut(event, handlerRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
