import { isEditableTarget, matchesShortcut, SHORTCUTS_BY_ID, type ShortcutKeyboardEvent } from '../../../lib/shortcuts.ts';

export type OfficeKeyAction = 'walk' | 'back';

/**
 * Maps a keydown to an office navigation action using the shortcuts registry (`office.walk`, `office.back`).
 * Returns null while typing in a text field or while a dialog is open, and for `V` when walk mode is
 * disabled in the preferences. Auto-repeat (a held key) returns null: V and Esc are toggles, so a held key
 * must not flip walk mode on/off or restart the fly-to. Walk movement (WASD) uses held-key state in
 * WalkControls and is unaffected. `/` (`office.search`) is handled by the quick-jump panel.
 */
export function officeKeyAction(
  e: ShortcutKeyboardEvent & { target: unknown; repeat?: boolean },
  ctx: { walkEnabled: boolean; modalOpen: boolean },
): OfficeKeyAction | null {
  if (e.repeat === true || ctx.modalOpen || isEditableTarget(e.target)) return null;
  if (matchesShortcut(e, SHORTCUTS_BY_ID['office.back'].chord)) return 'back';
  if (ctx.walkEnabled && matchesShortcut(e, SHORTCUTS_BY_ID['office.walk'].chord)) return 'walk';
  return null;
}
