import type { Provenance, StoryStatus } from '@aik/contracts';
import type { EventType } from './types.ts';

/** Which UI badge a transition event carries (spec §23). */
export function provenanceFor(eventType: EventType, to: StoryStatus): Provenance {
  if (to === 'DONE') return 'completion';
  switch (eventType) {
    case 'approve_plan':
    case 'request_changes':
      return 'human_approval';
    case 'verification_passed':
      return 'check_verified';
    case 'review_approved':
    case 'review_changes_requested':
      return 'review_decision';
    default:
      return 'system';
  }
}
