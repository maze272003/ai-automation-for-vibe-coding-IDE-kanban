// apps/ui/src/lib/transitions.ts
import type { StoryDTO, StoryStatus } from '@aik/contracts';
import { dragVerdict, type DragStory } from '@aik/workflow';
import { ApiRequestError, api } from './api.ts';

/** Adapts the API DTO (blocked.from) to the state machine's drag input (blockedFrom). */
export const toDragStory = (s: StoryDTO): DragStory => ({
  status: s.status,
  blockedFrom: s.blocked?.from ?? null,
  planningStatus: s.planningStatus,
  activePlanVersion: s.activePlanVersion,
});

export interface MoveUi {
  confirm(message: string): Promise<boolean>;
  askFindings(): Promise<string | null>;
  beforeRequest(): void;
}

/** Turns a board move into the single human event it may request. Empty reason = the user backed out. */
export async function performMove(story: StoryDTO, to: StoryStatus, ui: MoveUi): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = dragVerdict(toDragStory(story), to);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  const body: Record<string, unknown> = { event: verdict.target.event, expectedVersion: story.statusVersion };
  switch (verdict.target.event) {
    case 'cancel':
      if (!(await ui.confirm(`Cancel ${story.key}? Active work stops; the worktree is kept.`))) return { ok: false, reason: '' };
      break;
    case 'approve_plan':
      body.planVersion = story.activePlanVersion;
      break;
    case 'recover':
      body.target = verdict.target.recoverTarget;
      break;
    case 'request_changes': {
      const text = await ui.askFindings();
      if (!text) return { ok: false, reason: '' };
      body.sha = story.candidateSha;
      body.findings = [{ text }];
      break;
    }
  }
  ui.beforeRequest();
  try {
    await api.post(`/stories/${story.id}/transitions`, body);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { ok: false, reason: e.code === 'VERSION_CONFLICT' ? 'The story changed in the meantime; the board was refreshed' : e.reason };
  }
}
