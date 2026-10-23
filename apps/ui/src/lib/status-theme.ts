// apps/ui/src/lib/status-theme.ts — the single source of truth for status, priority and blocked colours.
import { BLOCKED_REASON, PRIORITY, STORY_STATUS, type BlockedReason, type Priority, type StoryStatus } from '@aik/contracts';

export interface StatusTheme {
  /** Human label used in headers, pills and sidebars. */
  label: string;
  /** Solid colour for the status dot. */
  dot: string;
  /** CSS gradient for the column's top rail. */
  rail: string;
  /** Translucent badge background. */
  softBg: string;
  /** Badge foreground, chosen for contrast against softBg. */
  softFg: string;
  /** Translucent glow used for drop targets and focus rings. */
  glow: string;
}

export interface PriorityTheme {
  label: string;
  softBg: string;
  softFg: string;
}

export interface BlockedTheme {
  label: string;
  softBg: string;
  softFg: string;
}

export const STATUS_THEME: Record<StoryStatus, StatusTheme> = {
  NEW: {
    label: 'New',
    dot: '#94a3b8',
    rail: 'linear-gradient(90deg, #94a3b8, rgb(148 163 184 / 0.15))',
    softBg: 'rgb(148 163 184 / 0.16)',
    softFg: '#cbd5e1',
    glow: 'rgb(148 163 184 / 0.55)',
  },
  READY: {
    label: 'Ready',
    dot: '#38bdf8',
    rail: 'linear-gradient(90deg, #38bdf8, rgb(56 189 248 / 0.15))',
    softBg: 'rgb(56 189 248 / 0.16)',
    softFg: '#7dd3fc',
    glow: 'rgb(56 189 248 / 0.55)',
  },
  IN_PROGRESS: {
    label: 'In progress',
    dot: '#a78bfa',
    rail: 'linear-gradient(90deg, #a78bfa, rgb(167 139 250 / 0.15))',
    softBg: 'rgb(167 139 250 / 0.18)',
    softFg: '#c4b5fd',
    glow: 'rgb(167 139 250 / 0.55)',
  },
  TESTING: {
    label: 'Testing',
    dot: '#22d3ee',
    rail: 'linear-gradient(90deg, #22d3ee, rgb(34 211 238 / 0.15))',
    softBg: 'rgb(34 211 238 / 0.16)',
    softFg: '#67e8f9',
    glow: 'rgb(34 211 238 / 0.55)',
  },
  READY_FOR_REVIEW: {
    label: 'Ready for review',
    dot: '#34d399',
    rail: 'linear-gradient(90deg, #34d399, rgb(52 211 153 / 0.15))',
    softBg: 'rgb(52 211 153 / 0.16)',
    softFg: '#6ee7b7',
    glow: 'rgb(52 211 153 / 0.55)',
  },
  REWORK: {
    label: 'Rework',
    dot: '#fbbf24',
    rail: 'linear-gradient(90deg, #fbbf24, rgb(251 191 36 / 0.15))',
    softBg: 'rgb(251 191 36 / 0.16)',
    softFg: '#fcd34d',
    glow: 'rgb(251 191 36 / 0.55)',
  },
  BLOCKED: {
    label: 'Blocked',
    dot: '#fb7185',
    rail: 'linear-gradient(90deg, #fb7185, rgb(251 113 133 / 0.15))',
    softBg: 'rgb(251 113 133 / 0.18)',
    softFg: '#fda4af',
    glow: 'rgb(251 113 133 / 0.55)',
  },
  AWAITING_MERGE: {
    label: 'Awaiting merge',
    dot: '#2dd4bf',
    rail: 'linear-gradient(90deg, #2dd4bf, rgb(45 212 191 / 0.15))',
    softBg: 'rgb(45 212 191 / 0.18)',
    softFg: '#5eead4',
    glow: 'rgb(45 212 191 / 0.55)',
  },
  DONE: {
    label: 'Done',
    dot: '#10b981',
    rail: 'linear-gradient(90deg, #10b981, rgb(16 185 129 / 0.15))',
    softBg: 'rgb(16 185 129 / 0.16)',
    softFg: '#6ee7b7',
    glow: 'rgb(16 185 129 / 0.55)',
  },
  CANCELLED: {
    label: 'Cancelled',
    dot: '#64748b',
    rail: 'linear-gradient(90deg, #64748b, rgb(100 116 139 / 0.15))',
    softBg: 'rgb(100 116 139 / 0.18)',
    softFg: '#9aa9bd',
    glow: 'rgb(100 116 139 / 0.55)',
  },
};

export const PRIORITY_THEME: Record<Priority, PriorityTheme> = {
  P0: { label: 'P0', softBg: 'rgb(244 63 94 / 0.16)', softFg: '#fda4af' },
  P1: { label: 'P1', softBg: 'rgb(244 114 182 / 0.16)', softFg: '#f9a8d4' },
  P2: { label: 'P2', softBg: 'rgb(148 163 184 / 0.16)', softFg: '#cbd5e1' },
  P3: { label: 'P3', softBg: 'rgb(100 116 139 / 0.16)', softFg: '#94a3b8' },
};

export const BLOCKED_REASON_THEME: Record<BlockedReason, BlockedTheme> = {
  retry_limit: { label: 'retry limit', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  no_progress: { label: 'no progress', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  quota: { label: 'quota', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  provider_down: { label: 'provider down', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  auth: { label: 'auth', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  conflict: { label: 'conflict', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  permission_denied: { label: 'permission denied', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  reviewer_blocked: { label: 'reviewer blocked', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  post_merge_failed: { label: 'post merge failed', softBg: 'rgb(251 113 133 / 0.18)', softFg: '#fecdd3' },
  interrupted: { label: 'interrupted', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  invalid_agent_output: { label: 'invalid agent output', softBg: 'rgb(251 113 133 / 0.16)', softFg: '#fecdd3' },
  model_limit: { label: 'model limit', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
  environment: { label: 'environment', softBg: 'rgb(251 191 36 / 0.16)', softFg: '#fcd34d' },
};

/** Guards against a contract enum gaining a member without a theme entry. */
export const ALL_STATUSES: readonly StoryStatus[] = STORY_STATUS;
export const ALL_PRIORITIES: readonly Priority[] = PRIORITY;
export const ALL_BLOCKED_REASONS: readonly BlockedReason[] = BLOCKED_REASON;
