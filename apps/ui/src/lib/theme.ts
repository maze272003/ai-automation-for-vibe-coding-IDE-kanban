/**
 * Theme store for the renderer.
 *
 * A stored *preference* (`light` / `dark` / `system`) resolves to the concrete
 * theme that is painted on `<html class="dark">`. The store owns the media-query
 * listener and the document class so there is exactly one source of truth:
 * `main.tsx` calls `initTheme()` before React renders and `useTheme()` subscribes
 * through `useSyncExternalStore`.
 *
 * `aik.theme` is the existing localStorage key. Values written by older builds
 * (`light` / `dark`) keep working; anything unrecognised falls back to `dark`,
 * which preserves the app's historical default.
 */

const STORAGE_KEY = 'aik.theme';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';
const DEFAULT_THEME: Theme = 'dark';

export type Theme = 'light' | 'dark';
export type ThemePreference = 'light' | 'dark' | 'system';

export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolved: Theme;
  readonly systemDark: boolean;
}

/** Accepts the three known preferences; every other value (including `null`) is `dark`. */
export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'dark';
}

/** Resolves a preference against the current OS colour scheme. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

// --- module store ---------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Cached immutable snapshot. `useSyncExternalStore` compares snapshots with
 * `Object.is`, so the object must keep its identity until something real
 * changes; otherwise React would re-render forever.
 */
let snapshot: ThemeSnapshot = Object.freeze({
  preference: DEFAULT_THEME,
  resolved: DEFAULT_THEME,
  systemDark: true,
});

let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((event: MediaQueryListEvent) => void) | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Publishes state only when it actually differs, returning whether it changed. */
function commit(preference: ThemePreference, systemDark: boolean): boolean {
  const resolved = resolveTheme(preference, systemDark);
  if (
    snapshot.preference === preference &&
    snapshot.resolved === resolved &&
    snapshot.systemDark === systemDark
  ) {
    return false;
  }
  snapshot = Object.freeze({ preference, resolved, systemDark });
  notify();
  return true;
}

function readStoredPreference(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistPreference(preference: ThemePreference): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* storage unavailable: the preference still applies for this session */
  }
}

function getMediaQuery(): MediaQueryList | null {
  if (mediaQuery) return mediaQuery;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    mediaQuery = window.matchMedia(SYSTEM_QUERY);
    return mediaQuery;
  } catch {
    return null;
  }
}

/**
 * The OS colour scheme. When `matchMedia` is unavailable (node tests, exotic
 * shells) the app's default theme wins rather than guessing `light`.
 */
function readSystemDark(): boolean {
  const query = getMediaQuery();
  return query ? query.matches : true;
}

function applyDocumentTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  root.classList.toggle('dark', theme === 'dark');
}

function listenForSystemTheme(): void {
  const query = getMediaQuery();
  if (!query || mediaListener) return;
  const listener = (event: MediaQueryListEvent): void => {
    const changed = commit(snapshot.preference, Boolean(event.matches));
    if (changed && snapshot.preference === 'system') {
      applyDocumentTheme(snapshot.resolved);
    }
  };
  try {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener);
    } else if (typeof query.addListener === 'function') {
      query.addListener(listener);
    } else {
      return;
    }
    mediaListener = listener;
  } catch {
    /* media query unavailable: keep the current theme */
  }
}

/** Current immutable snapshot; the same reference is returned until state changes. */
export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

/** Subscribes to preference/system changes. Returns an unsubscribe function. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads the stored preference, resolves it and paints `<html>`. Attaches the
 * single `prefers-color-scheme` listener exactly once; safe to call repeatedly.
 */
export function initTheme(): void {
  const preference = parseThemePreference(readStoredPreference());
  const systemDark = readSystemDark();
  commit(preference, systemDark);
  applyDocumentTheme(snapshot.resolved);
  listenForSystemTheme();
}

/** Persists and applies an explicit preference (used by the Settings radios and the hook). */
export function setThemePreference(preference: ThemePreference): void {
  const next = parseThemePreference(preference);
  persistPreference(next);
  commit(next, readSystemDark());
  applyDocumentTheme(snapshot.resolved);
  listenForSystemTheme();
}

/**
 * Flips to the opposite *resolved* theme and stores it explicitly. A `system`
 * preference therefore becomes a concrete `light`/`dark` choice.
 */
export function toggleTheme(): Theme {
  setThemePreference(snapshot.resolved === 'dark' ? 'light' : 'dark');
  return snapshot.resolved;
}

/** Legacy read helper: the currently resolved theme. */
export function loadTheme(): Theme {
  return snapshot.resolved;
}

/** Legacy write helper: applies `theme` as an explicit preference. */
export function applyTheme(theme: Theme): void {
  setThemePreference(theme === 'light' ? 'light' : 'dark');
}
