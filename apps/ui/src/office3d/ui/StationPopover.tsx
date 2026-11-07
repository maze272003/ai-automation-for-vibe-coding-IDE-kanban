import type { StationView } from '../state/selectors.ts';

/** Lists the stories at a station so the user can pick which terminal to open. */
export function StationPopover({ stories, onPick, onClose }: { stories: StationView['stories']; onPick: (storyId: number) => void; onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Pick a story" data-testid="office-station-popover" className="mt-1 rounded-panel border border-glass-border bg-surface-2 p-2 text-xs shadow-lg">
      <ul className="flex flex-col gap-1">
        {stories.map((s) => (
          <li key={s.storyId}>
            <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-glass/60" onClick={() => onPick(s.storyId)}>
              <span className="font-semibold">{s.storyKey}</span> <span className="text-muted">{s.state}</span>
              {s.title ? <span className="block truncate text-muted">{s.title}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-1 text-muted underline" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
