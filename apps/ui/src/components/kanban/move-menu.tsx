// apps/ui/src/components/kanban/move-menu.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { dragVerdict } from '@aik/workflow';
import { Fragment } from 'react';
import { STATUS_THEME } from '../../lib/status-theme.ts';
import { toDragStory } from '../../lib/transitions.ts';
import { Button } from '../ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx';

export function MoveMenu({ story, onMove }: { story: StoryDTO; onMove: (story: StoryDTO, to: StoryStatus) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" aria-haspopup="menu">
          Move to…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Move ${story.key} to`}>
        {STORY_STATUS.filter((s) => s !== story.status).map((to) => {
          const v = dragVerdict(toDragStory(story), to);
          const theme = STATUS_THEME[to];
          const reasonId = `move-reason-${story.id}-${to}`;
          return (
            <Fragment key={to}>
              <DropdownMenuItem
                disabled={!v.allowed}
                // E11: the verbatim title is part of the frozen e2e contract.
                title={v.allowed ? undefined : v.reason}
                // E12: the reason belongs in the DESCRIPTION, never in the accessible
                // name — the IN_PROGRESS reason contains the word "NEW", which would
                // make getByRole('menuitem', { name: 'NEW' }) ambiguous. The
                // description node lives outside the item so name-from-content stays
                // the raw status string.
                aria-describedby={v.allowed ? undefined : reasonId}
                onSelect={() => onMove(story, to)}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: theme.dot }} />
                <span>{to}</span>
                {!v.allowed && (
                  <span aria-hidden="true" className="ml-auto max-w-[9rem] truncate text-[10px] text-muted-2">
                    {v.reason}
                  </span>
                )}
              </DropdownMenuItem>
              {!v.allowed && (
                <span id={reasonId} className="sr-only">
                  {v.reason}
                </span>
              )}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
