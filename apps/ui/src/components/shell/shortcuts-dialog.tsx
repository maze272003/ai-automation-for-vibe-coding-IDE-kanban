// apps/ui/src/components/shell/shortcuts-dialog.tsx — IDE-6 shortcut reference.
// Uses the shared Radix Dialog (focus trap, Escape, title, focus restore) and
// lists every registry binding grouped in the spec's order.

import { SHORTCUTS, SHORTCUT_GROUPS, detectPlatform, formatChord, type ShortcutScope } from '../../lib/shortcuts.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';

const SCOPE_NOTE: Readonly<Record<ShortcutScope, string>> = {
  global: 'Anywhere outside text fields and open dialogs',
  code: 'Code tab',
  local: 'Panel/dialog only',
};

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const platform = detectPlatform();

  return (
    <Dialog open={open} title="Keyboard shortcuts" onClose={onClose}>
      <div data-testid="shortcuts-dialog" className="max-h-[60vh] overflow-y-auto pr-1">
        <p className="mb-3 text-xs text-muted">
          Shortcuts are fixed in this release. Global shortcuts are ignored while typing in a text field or while a dialog
          is open.
        </p>
        {SHORTCUT_GROUPS.map((group) => {
          const items = SHORTCUTS.filter((shortcut) => shortcut.group === group);
          if (items.length === 0) return null;
          const headingId = `shortcut-group-${group.toLowerCase()}`;
          return (
            <section key={group} aria-labelledby={headingId} className="mb-4 last:mb-0">
              <h3
                id={headingId}
                className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-2"
              >
                {group}
              </h3>
              <ul className="flex flex-col">
                {items.map((shortcut) => (
                  <li
                    key={shortcut.id}
                    data-testid={`shortcut-row-${shortcut.id}`}
                    className="flex items-center justify-between gap-4 border-t border-border/60 py-2 first:border-t-0"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground">{shortcut.label}</span>
                      <span className="block text-[10px] text-muted-2">{SCOPE_NOTE[shortcut.scope]}</span>
                    </span>
                    <kbd className="shrink-0 rounded-control border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                      {formatChord(shortcut.chord, platform)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end border-t border-border/60 pt-3">
        <Button data-testid="shortcuts-close" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
