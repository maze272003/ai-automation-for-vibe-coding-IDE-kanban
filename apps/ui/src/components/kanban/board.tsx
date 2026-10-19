// apps/ui/src/components/kanban/board.tsx
import { STORY_STATUS, type StoryDTO, type StoryStatus } from '@aik/contracts';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dragVerdict } from '@aik/workflow';
import { useCallback, useEffect, useState } from 'react';
import { performMove, toDragStory } from '../../lib/transitions.ts';
import { useToast } from '../ui/toast.tsx';
import { Column } from './column.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { RequestChangesDialog } from './request-changes-dialog.tsx';
import { TerminalModal } from './terminal-modal.tsx';

export function Board({ stories, onChanged }: { stories: StoryDTO[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [pending, setPending] = useState<Record<number, StoryStatus>>({});
  const [dragging, setDragging] = useState<StoryDTO | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ DONE: true, CANCELLED: true });
  const [confirm, setConfirm] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const [changes, setChanges] = useState<{ resolve: (text: string | null) => void } | null>(null);
  const [terminalStory, setTerminalStory] = useState<StoryDTO | null>(null);

  useEffect(
    () =>
      monitorForElements({
        onDragStart: ({ source }) => setDragging(stories.find((s) => s.id === source.data.storyId) ?? null),
        onDrop: () => setDragging(null),
      }),
    [stories],
  );

  const move = useCallback(
    async (story: StoryDTO, to: StoryStatus) => {
      const result = await performMove(story, to, {
        confirm: (message) => new Promise((resolve) => setConfirm({ message, resolve })),
        askFindings: () => new Promise((resolve) => setChanges({ resolve })),
        beforeRequest: () => setPending((p) => ({ ...p, [story.id]: to })),
      });
      setPending((p) => {
        const next = { ...p };
        delete next[story.id];
        return next;
      });
      if (!result.ok && result.reason) toast(result.reason, 'error');
      await onChanged();
    },
    [onChanged, toast],
  );

  const onDropStory = useCallback(
    (storyId: number, to: StoryStatus) => {
      const story = stories.find((s) => s.id === storyId);
      if (story) void move(story, to);
    },
    [stories, move],
  );

  const byStatus = Object.fromEntries(STORY_STATUS.map((s) => [s, [] as StoryDTO[]])) as Record<StoryStatus, StoryDTO[]>;
  for (const s of stories) byStatus[pending[s.id] ?? s.status].push(s);

  const currentTerminalStory = terminalStory
    ? stories.find((s) => s.id === terminalStory.id) ?? terminalStory
    : null;

  return (
    <div data-testid="board" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {STORY_STATUS.map((status) => (
        <Column
          key={status}
          status={status}
          stories={byStatus[status]}
          collapsible={status === 'DONE' || status === 'CANCELLED'}
          collapsed={collapsed[status] === true}
          highlight={dragging !== null && dragVerdict(toDragStory(dragging), status).allowed}
          onToggle={() => setCollapsed((c) => ({ ...c, [status]: !c[status] }))}
          onDropStory={onDropStory}
          onMove={(story, to) => void move(story, to)}
          onOpenTerminal={(story) => setTerminalStory(story)}
        />
      ))}
      <ConfirmDialog
        message={confirm?.message ?? null}
        onAnswer={(ok) => {
          confirm?.resolve(ok);
          setConfirm(null);
        }}
      />
      <RequestChangesDialog
        open={changes !== null}
        onAnswer={(text) => {
          changes?.resolve(text);
          setChanges(null);
        }}
      />
      {currentTerminalStory && (
        <TerminalModal
          story={currentTerminalStory}
          onClose={() => setTerminalStory(null)}
        />
      )}
    </div>
  );
}
