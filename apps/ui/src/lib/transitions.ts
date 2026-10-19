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

/** Parameterless human events the UI sends directly from card/modal controls. */
export type StoryActionEvent = 'stop_run' | 'hold' | 'unhold';

/** Sends stop_run/hold/unhold with the story's current version; errors map exactly like performMove's. */
export async function performEvent(
  story: StoryDTO,
  event: StoryActionEvent,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await api.post(`/stories/${story.id}/transitions`, { event, expectedVersion: story.statusVersion });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { ok: false, reason: e.code === 'VERSION_CONFLICT' ? 'The story changed in the meantime; the board was refreshed' : e.reason };
  }
}

/** One entry of an answer_clarifications request: the question's ordinal plus its answer. */
export interface ClarificationAnswer {
  ordinal: number;
  answer: string;
}

/** Sends reject_plan for the story's active plan with the reviewer's feedback; errors map exactly like performMove's. */
export async function rejectPlan(
  story: StoryDTO,
  feedback: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (story.activePlanVersion === null) return { ok: false, reason: 'No proposed plan to reject' };
  try {
    await api.post(`/stories/${story.id}/transitions`, {
      event: 'reject_plan',
      planVersion: story.activePlanVersion,
      feedback,
      expectedVersion: story.statusVersion,
    });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { ok: false, reason: e.code === 'VERSION_CONFLICT' ? 'The story changed in the meantime; the board was refreshed' : e.reason };
  }
}

/** Sends answer_clarifications (every open ordinal in one request); errors map exactly like performMove's. */
export async function answerClarifications(
  story: StoryDTO,
  answers: ClarificationAnswer[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (story.activePlanVersion === null) return { ok: false, reason: 'No plan is waiting for clarifications' };
  try {
    await api.post(`/stories/${story.id}/transitions`, {
      event: 'answer_clarifications',
      planVersion: story.activePlanVersion,
      answers,
      expectedVersion: story.statusVersion,
    });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { ok: false, reason: e.code === 'VERSION_CONFLICT' ? 'The story changed in the meantime; the board was refreshed' : e.reason };
  }
}
