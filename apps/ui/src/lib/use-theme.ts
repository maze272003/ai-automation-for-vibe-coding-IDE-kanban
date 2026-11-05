import { useSyncExternalStore } from 'react';
import {
  getThemeSnapshot,
  setThemePreference,
  subscribeTheme,
  toggleTheme,
  type Theme,
  type ThemePreference,
  type ThemeSnapshot,
} from './theme.ts';

/**
 * Server/initial snapshot. Stable by construction so `useSyncExternalStore`
 * does not loop when React asks for it repeatedly.
 */
const SERVER_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: 'dark',
  resolved: 'dark',
  systemDark: true,
});

function getServerSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

export interface UseThemeResult {
  preference: ThemePreference;
  resolved: Theme;
  systemDark: boolean;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
}

/** Subscribes a component to the module-level theme store. */
export function useTheme(): UseThemeResult {
  const snapshot = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerSnapshot);
  return {
    preference: snapshot.preference,
    resolved: snapshot.resolved,
    systemDark: snapshot.systemDark,
    setPreference: setThemePreference,
    toggle: toggleTheme,
  };
}
