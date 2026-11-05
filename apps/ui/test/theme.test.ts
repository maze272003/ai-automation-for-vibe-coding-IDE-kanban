// apps/ui/test/theme.test.ts
//
// The renderer theme store is DOM-adjacent, but vitest runs in the node
// environment. Every store test loads a fresh module instance after stubbing
// only the globals the module actually touches (`localStorage`, `window`,
// `document`); no jsdom or real browser is required.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseThemePreference, resolveTheme } from '../src/lib/theme.ts';

const STORAGE_KEY = 'aik.theme';

function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

function stubMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type === 'change') listeners.delete(listener);
    },
    addListener() {
      /* legacy no-op: addEventListener exists in this stub */
    },
    removeListener() {
      /* legacy no-op */
    },
    dispatchEvent() {
      return true;
    },
  };
  const matchMedia = vi.fn((_query: string) => mql);
  vi.stubGlobal('window', { matchMedia });
  return {
    matchMedia,
    mql,
    setMatches(next: boolean) {
      mql.matches = next;
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function stubDocument() {
  const classes = new Set<string>();
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          } else if (force) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
        contains(name: string) {
          return classes.has(name);
        },
      },
    },
  });
  return classes;
}

async function importTheme() {
  vi.resetModules();
  return import('../src/lib/theme.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('parseThemePreference', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['', 'dark'],
    ['auto', 'dark'],
    ['LIGHT', 'dark'],
    [' light', 'dark'],
    ['system ', 'dark'],
    [null, 'dark'],
  ] as const)('maps %j to %s', (raw, expected) => {
    expect(parseThemePreference(raw)).toBe(expected);
  });
});

describe('resolveTheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('resolves %s with systemDark=%s to %s', (preference, systemDark, expected) => {
    expect(resolveTheme(preference, systemDark)).toBe(expected);
  });
});

describe('theme store defaults and persistence', () => {
  it('defaults to dark when nothing is stored', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    stubMedia(false);
    const classes = stubDocument();
    const theme = await importTheme();

    theme.initTheme();

    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'dark', resolved: 'dark' });
    expect(classes.has('dark')).toBe(true);
    expect(theme.loadTheme()).toBe('dark');
  });

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'light'],
  ] as const)('maps the stored value %s to preference %s', async (stored, resolved) => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: stored }));
    stubMedia(false);
    stubDocument();
    const theme = await importTheme();

    theme.initTheme();

    expect(theme.getThemeSnapshot().preference).toBe(stored);
    expect(theme.getThemeSnapshot().resolved).toBe(resolved);
  });

  it('treats unknown legacy values as dark', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'sepia' }));
    stubMedia(false);
    const classes = stubDocument();
    const theme = await importTheme();

    theme.initTheme();

    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'dark', resolved: 'dark' });
    expect(classes.has('dark')).toBe(true);
  });

  it('falls back to dark when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('storage denied');
      },
      setItem() {
        throw new Error('storage denied');
      },
    });
    const theme = await importTheme();

    expect(() => theme.initTheme()).not.toThrow();
    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'dark', resolved: 'dark' });

    expect(() => theme.setThemePreference('light')).not.toThrow();
    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'light', resolved: 'light' });
  });

  it('persists explicit preferences under aik.theme', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const theme = await importTheme();

    theme.setThemePreference('light');

    expect(storage.getItem(STORAGE_KEY)).toBe('light');
    expect(theme.loadTheme()).toBe('light');
  });

  it('keeps the legacy applyTheme/loadTheme helpers on the explicit store', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const theme = await importTheme();

    theme.applyTheme('light');
    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'light', resolved: 'light' });
    expect(theme.loadTheme()).toBe('light');
    expect(storage.getItem(STORAGE_KEY)).toBe('light');

    theme.applyTheme('dark');
    expect(theme.loadTheme()).toBe('dark');
  });
});

describe('theme store snapshots', () => {
  it('returns the same frozen snapshot until something changes', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'dark' }));
    stubMedia(false);
    stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    const first = theme.getThemeSnapshot();
    expect(theme.getThemeSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);

    // Same preference and same system value: no new object.
    theme.setThemePreference('dark');
    expect(theme.getThemeSnapshot()).toBe(first);

    // A real change replaces the snapshot once.
    theme.setThemePreference('light');
    const second = theme.getThemeSnapshot();
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ preference: 'light', resolved: 'light' });
    expect(theme.getThemeSnapshot()).toBe(second);
  });

  it('notifies listeners only for real changes', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'dark' }));
    stubMedia(false);
    stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    const listener = vi.fn();
    const unsubscribe = theme.subscribeTheme(listener);

    theme.setThemePreference('dark');
    expect(listener).not.toHaveBeenCalled();

    theme.setThemePreference('light');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    theme.setThemePreference('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('toggles from the resolved value and stores an explicit preference', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'dark' });
    vi.stubGlobal('localStorage', storage);
    stubMedia(false);
    const classes = stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    expect(theme.toggleTheme()).toBe('light');
    expect(theme.getThemeSnapshot().preference).toBe('light');
    expect(classes.has('dark')).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe('light');

    expect(theme.toggleTheme()).toBe('dark');
    expect(theme.getThemeSnapshot().preference).toBe('dark');
    expect(classes.has('dark')).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('turns a system preference into an explicit choice when toggled', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'system' });
    vi.stubGlobal('localStorage', storage);
    stubMedia(true);
    const classes = stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'system', resolved: 'dark' });

    expect(theme.toggleTheme()).toBe('light');
    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'light', resolved: 'light' });
    expect(storage.getItem(STORAGE_KEY)).toBe('light');
    expect(classes.has('dark')).toBe(false);
  });
});

describe('system theme following', () => {
  it('re-resolves and repaints when the OS scheme changes under a system preference', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'system' }));
    const media = stubMedia(true);
    const classes = stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    const darkSnapshot = theme.getThemeSnapshot();
    expect(darkSnapshot.resolved).toBe('dark');
    expect(classes.has('dark')).toBe(true);

    media.setMatches(false);

    expect(theme.getThemeSnapshot()).not.toBe(darkSnapshot);
    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'system', systemDark: false, resolved: 'light' });
    expect(classes.has('dark')).toBe(false);

    media.setMatches(true);
    expect(theme.getThemeSnapshot().resolved).toBe('dark');
    expect(classes.has('dark')).toBe(true);
  });

  it('ignores OS changes when the preference is explicit', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'light' }));
    const media = stubMedia(false);
    const classes = stubDocument();
    const theme = await importTheme();
    theme.initTheme();

    media.setMatches(true);

    expect(theme.getThemeSnapshot()).toMatchObject({ preference: 'light', resolved: 'light', systemDark: true });
    expect(classes.has('dark')).toBe(false);
  });

  it('attaches exactly one media-query listener across repeated init/set calls', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'system' }));
    const media = stubMedia(false);
    stubDocument();
    const theme = await importTheme();

    theme.initTheme();
    theme.initTheme();
    theme.setThemePreference('system');
    theme.toggleTheme();
    theme.setThemePreference('system');

    expect(media.listenerCount()).toBe(1);
  });
});
