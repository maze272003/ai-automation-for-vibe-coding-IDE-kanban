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

/** Agent roles. The UI labels `implementer` "Coder" (`ROLE_LABELS`); `coder` is never persisted. */
export const ROLE = ['planner', 'implementer', 'reviewer', 'qa', 'security'] as const;
export type Role = (typeof ROLE)[number];

/** Agent runtimes a role can be routed to (spec §5.1, §5.5). */
export const RUNTIME_KIND = ['opencode', 'claude-code', 'codex'] as const;
export type RuntimeKind = (typeof RUNTIME_KIND)[number];

/** Reasoning efforts. `max` and `ultra` are explicit per-role overrides only (spec §5.6, R16). */
export const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORT)[number];

/** Efforts the model router may choose on its own; never `max` or `ultra`. */
export const AUTO_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly Effort[];
export type AutoEffort = (typeof AUTO_EFFORTS)[number];

/** Normalized failure classes of a CLI runtime run (spec §5.1). */
export const RUNTIME_FAILURE = ['auth', 'quota', 'not_installed', 'timeout', 'budget', 'crashed', 'invalid_output'] as const;
export type RuntimeFailure = (typeof RUNTIME_FAILURE)[number];

export const PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITY)[number];

export const COMPLEXITY = ['S', 'M', 'L', 'XL'] as const;
export type Complexity = (typeof COMPLEXITY)[number];

export const PLAN_STATUS = ['proposed', 'approved', 'rejected', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const VERDICT = ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] as const;
export type Verdict = (typeof VERDICT)[number];
