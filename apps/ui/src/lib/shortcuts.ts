// apps/ui/src/lib/shortcuts.ts — pure keyboard-shortcut registry and helpers (IDE-6).
//
// Chords are stored lower-case with `mod` as the platform-primary modifier
// (Ctrl on Windows/Linux, Meta on macOS). This module has no React or DOM
// dependency at import time so it can be unit-tested in the node environment.

export type ShortcutScope = 'global' | 'code' | 'local';

export type ShortcutGroup = 'Navigation' | 'View' | 'Editor' | 'Help' | 'Local';

export type ShortcutId =
  | 'nav.projects'
  | 'nav.usage'
  | 'nav.office'
  | 'nav.settings'
  | 'nav.diagnostics'
  | 'view.theme'
  | 'help.shortcuts'
  | 'editor.save'
  | 'editor.search'
  | 'view.terminal'
  | 'scm.commit'
  | 'dialog.close';

export type Platform = 'win32' | 'darwin' | 'linux';

export interface Shortcut {
  id: ShortcutId;
  chord: string;
  label: string;
  scope: ShortcutScope;
  group: ShortcutGroup;
}

/** The minimal shape of a keyboard event the matcher needs. */
export interface ShortcutKeyboardEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Display order used by the shortcut reference dialog. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Navigation', 'View', 'Editor', 'Help', 'Local'];

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'nav.projects', chord: 'mod+1', label: 'Go to Projects', scope: 'global', group: 'Navigation' },
  { id: 'nav.usage', chord: 'mod+2', label: 'Go to Usage', scope: 'global', group: 'Navigation' },
  { id: 'nav.office', chord: 'mod+3', label: 'Go to Office', scope: 'global', group: 'Navigation' },
  { id: 'nav.settings', chord: 'mod+,', label: 'Go to Settings', scope: 'global', group: 'Navigation' },
  { id: 'nav.diagnostics', chord: 'mod+shift+d', label: 'Go to Diagnostics', scope: 'global', group: 'Navigation' },
  { id: 'view.theme', chord: 'mod+shift+l', label: 'Toggle light/dark theme', scope: 'global', group: 'View' },
  { id: 'help.shortcuts', chord: 'f1', label: 'Open keyboard shortcuts', scope: 'global', group: 'Help' },
  { id: 'editor.save', chord: 'mod+s', label: 'Save the open file', scope: 'code', group: 'Editor' },
  { id: 'editor.search', chord: 'mod+shift+f', label: 'Open search', scope: 'code', group: 'Editor' },
  { id: 'view.terminal', chord: 'mod+`', label: 'Toggle the integrated terminal', scope: 'code', group: 'View' },
  { id: 'scm.commit', chord: 'mod+enter', label: 'Commit from the Git panel', scope: 'local', group: 'Local' },
  { id: 'dialog.close', chord: 'escape', label: 'Close the focused dialog', scope: 'local', group: 'Local' },
];

export const GLOBAL_SHORTCUTS: readonly Shortcut[] = SHORTCUTS.filter((shortcut) => shortcut.scope === 'global');

export const CODE_SHORTCUTS: readonly Shortcut[] = SHORTCUTS.filter((shortcut) => shortcut.scope === 'code');

const byId = {} as Record<ShortcutId, Shortcut>;
for (const shortcut of SHORTCUTS) byId[shortcut.id] = shortcut;

export const SHORTCUTS_BY_ID: Readonly<Record<ShortcutId, Shortcut>> = Object.freeze(byId);

const FUNCTION_KEY = /^f(?:[1-9]|1[0-9]|2[0-4])$/i;

interface ParsedChord {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Canonical registry/DOM key names: letters lower-case, symbols verbatim, named keys title-case. */
function canonicalKey(key: string): string {
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toLowerCase() : key;
  if (FUNCTION_KEY.test(key)) return key.toUpperCase();
  switch (key.toLowerCase()) {
    case 'enter':
      return 'Enter';
    case 'escape':
    case 'esc':
      return 'Escape';
    case 'space':
      return 'Space';
    case 'tab':
      return 'Tab';
    case 'backspace':
      return 'Backspace';
    case 'delete':
      return 'Delete';
    case 'insert':
      return 'Insert';
    case 'home':
      return 'Home';
    case 'end':
      return 'End';
    case 'pageup':
      return 'PageUp';
    case 'pagedown':
      return 'PageDown';
    case 'up':
      return 'ArrowUp';
    case 'down':
      return 'ArrowDown';
    case 'left':
      return 'ArrowLeft';
    case 'right':
      return 'ArrowRight';
    default:
      return key;
  }
}

function parseChord(chord: string): ParsedChord {
  const parts = chord.split('+');
  const rawKey = parts.pop() ?? '';
  const parsed: ParsedChord = { mod: false, ctrl: false, meta: false, shift: false, alt: false, key: canonicalKey(rawKey) };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod':
        parsed.mod = true;
        break;
      case 'ctrl':
      case 'control':
        parsed.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        parsed.meta = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      default:
        // Unknown modifier tokens are ignored rather than silently broadening the match.
        break;
    }
  }
  return parsed;
}

/**
 * True when the event matches the chord exactly: the platform's `mod` key, no
 * extra modifiers, and the canonical key. Letters are case-insensitive; symbols
 * (`,`/backtick) and named keys (F1/Enter/Escape) compare exactly.
 */
export function matchesShortcut(
  event: ShortcutKeyboardEvent,
  chord: string,
  platform: Platform = detectPlatform(),
): boolean {
  const parsed = parseChord(chord);
  const mac = platform === 'darwin';
  const wantsCtrl = parsed.ctrl || (parsed.mod && !mac);
  const wantsMeta = parsed.meta || (parsed.mod && mac);
  return (
    (event.key.length === 1 ? canonicalKey(event.key) : event.key) === parsed.key &&
    Boolean(event.ctrlKey) === wantsCtrl &&
    Boolean(event.metaKey) === wantsMeta &&
    Boolean(event.shiftKey) === parsed.shift &&
    Boolean(event.altKey) === parsed.alt
  );
}

const MAC_MODIFIERS: Readonly<Record<'mod' | 'ctrl' | 'alt' | 'shift', string>> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
};

function displayKey(key: string): string {
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return key;
}

/** Formats a registry chord for display: `Ctrl+Shift+D` (Windows/Linux) or `⌘⇧D` (macOS). */
export function formatChord(chord: string, platform: Platform = detectPlatform()): string {
  const parsed = parseChord(chord);
  if (platform === 'darwin') {
    let prefix = '';
    if (parsed.mod) prefix += MAC_MODIFIERS.mod;
    if (parsed.ctrl) prefix += MAC_MODIFIERS.ctrl;
    if (parsed.alt) prefix += MAC_MODIFIERS.alt;
    if (parsed.shift) prefix += MAC_MODIFIERS.shift;
    return `${prefix}${displayKey(parsed.key)}`;
  }
  const parts: string[] = [];
  if (parsed.ctrl || parsed.mod) parts.push('Ctrl');
  if (parsed.meta) parts.push('Meta');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(displayKey(parsed.key));
  return parts.join('+');
}

/** Detects the renderer platform without touching `navigator` when it is absent (node tests/SSR). */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'win32';
  const nav = navigator as Navigator & { platform?: string; userAgent?: string };
  const platform = typeof nav.platform === 'string' ? nav.platform : '';
  const userAgent = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  const source = `${platform} ${userAgent}`.toLowerCase();
  if (source.includes('mac')) return 'darwin';
  if (source.includes('linux') || source.includes('x11')) return 'linux';
  return 'win32';
}

interface EditableTargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  parentElement?: EditableTargetLike | null;
}

/**
 * True when the event target is (or sits inside) a text-entry surface. This
 * includes Monaco's hidden textarea and contenteditable editors.
 */
export function isEditableTarget(target: unknown): boolean {
  let node = target as EditableTargetLike | null | undefined;
  while (node) {
    const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (node.isContentEditable === true) return true;
    node = node.parentElement;
  }
  return false;
}

/** True when any Radix (or native) dialog is open. Radix sets role="dialog", not aria-modal. */
export function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[role="dialog"]') !== null;
}
