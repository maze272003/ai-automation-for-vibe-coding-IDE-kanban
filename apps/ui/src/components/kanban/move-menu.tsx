// apps/ui/src/components/kanban/move-menu.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { dragVerdict } from '@aik/workflow';
import { useState } from 'react';
import { toDragStory } from '../../lib/transitions.ts';
import { Button } from '../ui/button.tsx';

export function MoveMenu({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mt-2">
      <Button variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Move to…</Button>
      {open && (
        <ul role="menu" aria-label={`Move ${story.key} to`} className="absolute z-10 mt-1 w-56 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {STORY_STATUS.filter((s) => s !== story.status).map((to) => {
            const v = dragVerdict(toDragStory(story), to);
            return (
              <li key={to} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!v.allowed}
                  title={v.allowed ? undefined : v.reason}
                  onClick={() => {
                    setOpen(false);
                    onMove(story, to);
                  }}
                  className="w-full rounded px-2 py-1 text-left text-sm enabled:hover:bg-zinc-100 disabled:opacity-40 dark:enabled:hover:bg-zinc-800"
                >
                  {to}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
