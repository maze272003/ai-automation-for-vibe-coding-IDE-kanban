import { RESUMABLE_STATUSES, isTerminal, type PlanningStatus, type StoryStatus } from '@aik/contracts';

export interface DragStory {
  status: StoryStatus;
  blockedFrom: StoryStatus | null;
  planningStatus: PlanningStatus;
  activePlanVersion: number | null;
}
export interface DragTarget {
  to: StoryStatus;
  event: 'approve_plan' | 'cancel' | 'request_changes' | 'recover';
  recoverTarget?: 'READY' | 'NEW' | 'resume';
}
export type DragVerdict = { allowed: true; target: DragTarget } | { allowed: false; reason: string };

/** Maps a Kanban drop (or "Move to…") onto the one human event it may request — or explains why not. */
export function dragVerdict(story: DragStory, to: StoryStatus): DragVerdict {
  const from = story.status;
  if (from === to) return { allowed: false, reason: 'The story is already in this column' };
  if (isTerminal(from)) return { allowed: false, reason: `${from} is final` };
  if (to === 'CANCELLED') return { allowed: true, target: { to, event: 'cancel' } };
  if (from === 'NEW' && to === 'READY') {
    return story.planningStatus === 'plan_proposed' && story.activePlanVersion !== null
      ? { allowed: true, target: { to, event: 'approve_plan' } }
      : { allowed: false, reason: 'There is no proposed plan to approve yet' };
  }
  if (from === 'AWAITING_MERGE' && to === 'REWORK') return { allowed: true, target: { to, event: 'request_changes' } };
  if (from === 'BLOCKED') {
    if (to === 'READY') return { allowed: true, target: { to, event: 'recover', recoverTarget: 'READY' } };
    if (to === 'NEW') return { allowed: true, target: { to, event: 'recover', recoverTarget: 'NEW' } };
    if (to === story.blockedFrom && RESUMABLE_STATUSES.includes(to)) {
      return { allowed: true, target: { to, event: 'recover', recoverTarget: 'resume' } };
    }
    const resumable = story.blockedFrom && RESUMABLE_STATUSES.includes(story.blockedFrom) ? `, or back to ${story.blockedFrom}` : '';
    return { allowed: false, reason: `A blocked story can only be recovered to READY or NEW${resumable}` };
  }
  if (to === 'DONE') return { allowed: false, reason: 'Stories become DONE only after an approved, verified merge' };
  return { allowed: false, reason: `Only the orchestrator moves stories from ${from} to ${to}` };
}
