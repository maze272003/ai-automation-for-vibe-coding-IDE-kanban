export const STORY_STATUS = [
  'NEW', 'READY', 'IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'BLOCKED', 'AWAITING_MERGE', 'DONE', 'CANCELLED',
] as const;
export type StoryStatus = (typeof STORY_STATUS)[number];

export const TERMINAL_STATUSES: readonly StoryStatus[] = ['DONE', 'CANCELLED'];
export const ACTIVE_STATUSES: readonly StoryStatus[] = ['IN_PROGRESS', 'TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'];
export const RESUMABLE_STATUSES: readonly StoryStatus[] = ['TESTING', 'READY_FOR_REVIEW', 'REWORK', 'AWAITING_MERGE'];
export const isTerminal = (s: StoryStatus): boolean => TERMINAL_STATUSES.includes(s);

export const PLANNING_STATUS = ['none', 'planning', 'needs_clarification', 'plan_proposed', 'plan_approved', 'planning_failed'] as const;
export type PlanningStatus = (typeof PLANNING_STATUS)[number];

export const BLOCKED_REASON = [
  'retry_limit', 'no_progress', 'quota', 'provider_down', 'auth', 'conflict', 'permission_denied',
  'reviewer_blocked', 'post_merge_failed', 'interrupted', 'invalid_agent_output', 'model_limit', 'environment',
] as const;
export type BlockedReason = (typeof BLOCKED_REASON)[number];

export const ROLE = ['planner', 'implementer', 'reviewer'] as const;
export type Role = (typeof ROLE)[number];

export const PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITY)[number];

export const COMPLEXITY = ['S', 'M', 'L', 'XL'] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const PLAN_STATUS = ['proposed', 'approved', 'rejected', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const VERDICT = ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] as const;
export type Verdict = (typeof VERDICT)[number];
