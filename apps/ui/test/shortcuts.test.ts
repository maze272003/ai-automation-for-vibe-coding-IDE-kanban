// apps/ui/test/shortcuts.test.ts — pure registry/matcher/dispatch coverage (IDE-6).
// Node environment on purpose: none of these helpers require a DOM.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SHORTCUT_HELP_EVENT, openShortcutHelp, subscribeShortcutHelp } from '../src/lib/shortcut-help.ts';
import {
  CODE_SHORTCUTS,
  GLOBAL_SHORTCUTS,
  SHORTCUTS,
  SHORTCUTS_BY_ID,
  SHORTCUT_GROUPS,
  detectPlatform,
  formatChord,
  isEditableTarget,
  isModalOpen,
  matchesShortcut,
  type ShortcutKeyboardEvent,
} from '../src/lib/shortcuts.ts';
import {
  dispatchGlobalShortcut,
  type GlobalShortcutEvent,
  type GlobalShortcutHandlers,
} from '../src/lib/use-global-shortcuts.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds the DOM-shaped event for a registry chord, without importing test-only internals. */
function eventForChord(chord: string, platform: 'win32' | 'darwin' | 'linux' = 'win32'): ShortcutKeyboardEvent {
  const parts = chord.split('+');
  const rawKey = parts.pop() ?? '';
  const key =
    rawKey.length === 1
      ? /[a-z]/.test(rawKey)
        ? rawKey.toUpperCase()
        : rawKey
      : rawKey === 'f1'
        ? 'F1'
        : rawKey === 'enter'
          ? 'Enter'
          : rawKey === 'escape'
            ? 'Escape'
            : rawKey;
  const event: ShortcutKeyboardEvent = { key };
  for (const part of parts) {
    if (part === 'mod') {
      if (platform === 'darwin') event.metaKey = true;
      else event.ctrlKey = true;
    } else if (part === 'ctrl') event.ctrlKey = true;
    else if (part === 'shift') event.shiftKey = true;
    else if (part === 'alt') event.altKey = true;
  }
  return event;
}

describe('shortcut registry', () => {
  test('matches the spec table exactly (id, chord, scope, group)', () => {
    const expected: Array<[string, string, string, string]> = [
      ['nav.projects', 'mod+1', 'global', 'Navigation'],
      ['nav.usage', 'mod+2', 'global', 'Navigation'],
      ['nav.office', 'mod+3', 'global', 'Navigation'],
      ['nav.settings', 'mod+,', 'global', 'Navigation'],
      ['nav.diagnostics', 'mod+shift+d', 'global', 'Navigation'],
      ['view.theme', 'mod+shift+l', 'global', 'View'],
      ['help.shortcuts', 'f1', 'global', 'Help'],
      ['editor.save', 'mod+s', 'code', 'Editor'],
      ['editor.search', 'mod+shift+f', 'code', 'Editor'],
      ['view.terminal', 'mod+`', 'code', 'View'],
      ['scm.commit', 'mod+enter', 'local', 'Local'],
      ['dialog.close', 'escape', 'local', 'Local'],
    ];
    expect(SHORTCUTS.map(({ id, chord, scope, group }) => [id, chord, scope, group])).toEqual(expected);
    expect(SHORTCUTS.every((shortcut) => shortcut.label.trim().length > 0)).toBe(true);
  });

  test('ids are unique and every group is one of the five reference groups', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SHORTCUT_GROUPS).toEqual(['Navigation', 'View', 'Editor', 'Help', 'Local']);
    expect(new Set(SHORTCUTS.map((shortcut) => shortcut.group))).toEqual(new Set(SHORTCUT_GROUPS));
    expect(SHORTCUTS_BY_ID['nav.projects']).toBe(SHORTCUTS[0]);
  });

  test('scope partitions match the spec', () => {
    expect(SHORTCUTS).toHaveLength(12);
    expect(GLOBAL_SHORTCUTS.map((shortcut) => shortcut.id)).toEqual([
      'nav.projects',
      'nav.usage',
      'nav.office',
      'nav.settings',
      'nav.diagnostics',
      'view.theme',
      'help.shortcuts',
    ]);
    expect(CODE_SHORTCUTS.map((shortcut) => shortcut.id)).toEqual(['editor.save', 'editor.search', 'view.terminal']);
    expect(GLOBAL_SHORTCUTS.every((shortcut) => shortcut.scope === 'global')).toBe(true);
    expect(CODE_SHORTCUTS.every((shortcut) => shortcut.scope === 'code')).toBe(true);
  });

  test('every binding resolves through SHORTCUTS_BY_ID', () => {
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUTS_BY_ID[shortcut.id]).toBe(shortcut);
    }
  });

  test('reserved Electron chords are not bound', () => {
    const reserved = ['mod+r', 'mod+w', 'mod+shift+i', 'ctrl+r', 'ctrl+w', 'ctrl+shift+i'];
    for (const shortcut of SHORTCUTS) {
      expect(reserved).not.toContain(shortcut.chord);
    }
  });
});

describe('matchesShortcut', () => {
  test('matches every registry chord with its own platform event', () => {
    for (const shortcut of SHORTCUTS) {
      expect(matchesShortcut(eventForChord(shortcut.chord, 'win32'), shortcut.chord, 'win32')).toBe(true);
      expect(matchesShortcut(eventForChord(shortcut.chord, 'linux'), shortcut.chord, 'linux')).toBe(true);
      expect(matchesShortcut(eventForChord(shortcut.chord, 'darwin'), shortcut.chord, 'darwin')).toBe(true);
    }
  });

  test('mod is Ctrl on Windows/Linux and Meta on macOS', () => {
    expect(matchesShortcut({ key: '1', ctrlKey: true }, 'mod+1', 'win32')).toBe(true);
    expect(matchesShortcut({ key: '1', ctrlKey: true }, 'mod+1', 'linux')).toBe(true);
    expect(matchesShortcut({ key: '1', metaKey: true }, 'mod+1', 'win32')).toBe(false);
    expect(matchesShortcut({ key: '1', metaKey: true }, 'mod+1', 'darwin')).toBe(true);
    expect(matchesShortcut({ key: '1', ctrlKey: true }, 'mod+1', 'darwin')).toBe(false);
    expect(matchesShortcut({ key: '1' }, 'mod+1', 'win32')).toBe(false);
  });

  test('rejects extra modifiers on every chord', () => {
    for (const shortcut of SHORTCUTS) {
      const base = eventForChord(shortcut.chord, 'win32');
      const extraModifiers: Array<keyof ShortcutKeyboardEvent> = ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'];
      for (const modifier of extraModifiers) {
        if (base[modifier] === true) continue; // already required by this chord
        expect(matchesShortcut({ ...base, [modifier]: true }, shortcut.chord, 'win32')).toBe(false);
      }
    }
    expect(matchesShortcut({ key: 's', ctrlKey: true, altKey: true }, 'mod+s', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 's', ctrlKey: true, metaKey: true }, 'mod+s', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 's', metaKey: true, ctrlKey: true }, 'mod+s', 'darwin')).toBe(false);
  });

  test('matches letters case-insensitively', () => {
    expect(matchesShortcut({ key: 's', ctrlKey: true }, 'mod+s', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'S', ctrlKey: true }, 'mod+s', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 's', ctrlKey: true }, 'mod+S', 'win32')).toBe(true);
  });

  test('symbols and named keys compare exactly', () => {
    expect(matchesShortcut({ key: ',', ctrlKey: true }, 'mod+,', 'win32')).toBe(true);
    expect(matchesShortcut({ key: '<', ctrlKey: true }, 'mod+,', 'win32')).toBe(false);
    expect(matchesShortcut({ key: '`', ctrlKey: true }, 'mod+`', 'win32')).toBe(true);
    expect(matchesShortcut({ key: '~', ctrlKey: true }, 'mod+`', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 'F1' }, 'f1', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'f1' }, 'f1', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 'Enter', ctrlKey: true }, 'mod+enter', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'enter', ctrlKey: true }, 'mod+enter', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 'Escape' }, 'escape', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'Esc' }, 'escape', 'win32')).toBe(false);
  });

  test('shift and alt must match exactly', () => {
    expect(matchesShortcut({ key: 'd', ctrlKey: true }, 'mod+shift+d', 'win32')).toBe(false);
    expect(matchesShortcut({ key: 'D', ctrlKey: true, shiftKey: true }, 'mod+shift+d', 'win32')).toBe(true);
    expect(matchesShortcut({ key: 'd', ctrlKey: true, shiftKey: true, altKey: true }, 'mod+shift+d', 'win32')).toBe(false);
  });
});

describe('formatChord', () => {
  test('formats Windows/Linux chords with Ctrl', () => {
    expect(formatChord('mod+shift+d', 'win32')).toBe('Ctrl+Shift+D');
    expect(formatChord('mod+shift+d', 'linux')).toBe('Ctrl+Shift+D');
    expect(formatChord('mod+,', 'win32')).toBe('Ctrl+,');
    expect(formatChord('mod+`', 'win32')).toBe('Ctrl+`');
    expect(formatChord('mod+enter', 'win32')).toBe('Ctrl+Enter');
    expect(formatChord('escape', 'win32')).toBe('Escape');
    expect(formatChord('f1', 'win32')).toBe('F1');
    expect(formatChord('mod+1', 'win32')).toBe('Ctrl+1');
  });

  test('formats macOS chords with symbols', () => {
    expect(formatChord('mod+shift+d', 'darwin')).toBe('⌘⇧D');
    expect(formatChord('mod+shift+l', 'darwin')).toBe('⌘⇧L');
    expect(formatChord('mod+,', 'darwin')).toBe('⌘,');
    expect(formatChord('f1', 'darwin')).toBe('F1');
    expect(formatChord('escape', 'darwin')).toBe('Escape');
    expect(formatChord('mod+alt+1', 'darwin')).toBe('⌘⌥1');
  });

  test('detectPlatform is guarded and recognises macOS, Windows and Linux', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectPlatform()).toBe('win32');

    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' });
    expect(detectPlatform()).toBe('darwin');

    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
    expect(detectPlatform()).toBe('win32');

    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(detectPlatform()).toBe('linux');

    vi.stubGlobal('navigator', {});
    expect(detectPlatform()).toBe('win32');
  });
});

describe('isEditableTarget', () => {
  test('covers inputs, textareas and selects', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
  });

  test('walks ancestors and contenteditable surfaces (Monaco)', () => {
    const monaco = { tagName: 'DIV', isContentEditable: true };
    expect(isEditableTarget(monaco)).toBe(true);
    expect(isEditableTarget({ tagName: 'SPAN', parentElement: monaco })).toBe(true);
    expect(isEditableTarget({ tagName: 'SPAN', parentElement: { tagName: 'INPUT' } })).toBe(true);
    expect(
      isEditableTarget({
        tagName: 'SPAN',
        parentElement: { tagName: 'DIV', parentElement: { tagName: 'TEXTAREA' } },
      }),
    ).toBe(true);
  });

  test('ignores ordinary and missing targets', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false, parentElement: { tagName: 'BODY' } })).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});

describe('isModalOpen', () => {
  test('is guarded without a document and queries role="dialog" when present', () => {
    expect(isModalOpen()).toBe(false);

    const querySelector = vi.fn<() => Element | null>(() => null);
    vi.stubGlobal('document', { querySelector });
    expect(isModalOpen()).toBe(false);
    expect(querySelector).toHaveBeenLastCalledWith('[role="dialog"]');

    querySelector.mockReturnValue({} as Element);
    expect(isModalOpen()).toBe(true);
  });
});

function makeDispatchEvent(overrides: Partial<GlobalShortcutEvent> = {}) {
  const preventDefault = vi.fn();
  const event: GlobalShortcutEvent = { key: '', preventDefault, ...overrides };
  return { event, preventDefault };
}

describe('dispatchGlobalShortcut', () => {
  test('dispatches a matched global binding and only then prevents default', () => {
    const handler = vi.fn();
    const { event, preventDefault } = makeDispatchEvent({ key: '1', ctrlKey: true });
    expect(dispatchGlobalShortcut(event, { 'nav.projects': handler }, { platform: 'win32' })).toBe('nav.projects');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('does not dispatch code or local bindings', () => {
    const handler = vi.fn();
    for (const [key, extra] of [
      ['s', { ctrlKey: true }],
      ['f', { ctrlKey: true, shiftKey: true }],
      ['Enter', { ctrlKey: true }],
      ['Escape', {}],
    ] as const) {
      const { event, preventDefault } = makeDispatchEvent({ key, ...extra });
      expect(dispatchGlobalShortcut(event, { 'nav.projects': handler }, { platform: 'win32' })).toBeNull();
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  test('a match without a handler does not prevent default', () => {
    const { event, preventDefault } = makeDispatchEvent({ key: '1', ctrlKey: true });
    expect(dispatchGlobalShortcut(event, {}, { platform: 'win32' })).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test('ignores defaultPrevented and repeat events', () => {
    const handler = vi.fn();
    const prevented = makeDispatchEvent({ key: '1', ctrlKey: true, defaultPrevented: true });
    expect(dispatchGlobalShortcut(prevented.event, { 'nav.projects': handler }, { platform: 'win32' })).toBeNull();
    expect(prevented.preventDefault).not.toHaveBeenCalled();

    const repeated = makeDispatchEvent({ key: '1', ctrlKey: true, repeat: true });
    expect(dispatchGlobalShortcut(repeated.event, { 'nav.projects': handler }, { platform: 'win32' })).toBeNull();
    expect(repeated.preventDefault).not.toHaveBeenCalled();

    expect(handler).not.toHaveBeenCalled();
  });

  test('ignores editable targets and every open dialog, including F1', () => {
    const help = vi.fn();
    const editable = makeDispatchEvent({ key: 'F1', target: { tagName: 'TEXTAREA' } });
    expect(dispatchGlobalShortcut(editable.event, { 'help.shortcuts': help }, { platform: 'win32' })).toBeNull();
    expect(editable.preventDefault).not.toHaveBeenCalled();

    const modal = makeDispatchEvent({ key: 'F1' });
    expect(
      dispatchGlobalShortcut(modal.event, { 'help.shortcuts': help }, { platform: 'win32', isModalOpen: () => true }),
    ).toBeNull();
    expect(modal.preventDefault).not.toHaveBeenCalled();

    const modalNav = makeDispatchEvent({ key: '1', ctrlKey: true });
    expect(
      dispatchGlobalShortcut(modalNav.event, { 'nav.projects': help }, { platform: 'win32', isModalOpen: () => true }),
    ).toBeNull();
    expect(help).not.toHaveBeenCalled();
  });

  test('every global binding has a documented handler key', () => {
    const handlers: GlobalShortcutHandlers = {
      'nav.projects': () => undefined,
      'nav.usage': () => undefined,
      'nav.office': () => undefined,
      'nav.settings': () => undefined,
      'nav.diagnostics': () => undefined,
      'view.theme': () => undefined,
      'help.shortcuts': () => undefined,
    };
    expect(Object.keys(handlers).sort()).toEqual(GLOBAL_SHORTCUTS.map((shortcut) => shortcut.id).sort());
  });

  test('dispatches F1 through the global handler map', () => {
    const help = vi.fn();
    const { event, preventDefault } = makeDispatchEvent({ key: 'F1' });
    expect(dispatchGlobalShortcut(event, { 'help.shortcuts': help }, { platform: 'win32' })).toBe('help.shortcuts');
    expect(help).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('shortcut-help event', () => {
  test('dispatches on window and unsubscribes cleanly', () => {
    expect(SHORTCUT_HELP_EVENT).toBe('aik:shortcuts-help');

    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen = vi.fn();
    const unsubscribe = subscribeShortcutHelp(seen);

    openShortcutHelp();
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    openShortcutHelp();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
