import type { OfficePreferences, RoomCustomization, ScreenToggles } from '@aik/contracts';
import { STATE_COLOR } from '../screens/paint.ts';
import type { StationState } from './selectors.ts';

export type AgentMovement = OfficePreferences['agentMovement'];

/** A room's own screen toggles win; `null` means "inherit the global default". */
export function effectiveScreens(room: Pick<RoomCustomization, 'screens'>, prefs: OfficePreferences): ScreenToggles {
  return room.screens ?? prefs.screens;
}

export function effectiveStatusColor(state: StationState, prefs: OfficePreferences): string {
  return prefs.statusColors[state] ?? STATE_COLOR[state];
}

/** Low graphics quality forces desk-only movement (spec 6.5a) unless the user switched movement off. */
export function effectiveMovement(prefs: OfficePreferences): AgentMovement {
  if (prefs.agentMovement === 'off') return 'off';
  return prefs.quality === 'low' ? 'desk' : prefs.agentMovement;
}
