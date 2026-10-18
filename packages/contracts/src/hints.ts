import type { BlockedReason } from './enums.ts';

/** Human-readable recovery hints for each BLOCKED reason (spec §16.5). */
export const BLOCKED_HINTS: Record<BlockedReason, string> = {
  retry_limit: 'The attempt budget is used up. Review the last findings, then edit the plan or grant extra attempts.',
  no_progress: 'The last repair produced an identical result. Re-plan or edit the story.',
  quota: 'The model provider quota is exhausted. Resume after it resets or enable another provider.',
  provider_down: 'The model provider is unavailable. Resume when it is back.',
  auth: 'Credentials expired or were revoked. Reconnect, then resume.',
  conflict: 'A merge conflict needs resolution. Resolve it in the worktree, then resume.',
  permission_denied: 'An agent action was denied by project policy. Adjust the policy if appropriate, then recover.',
  reviewer_blocked: 'The reviewer blocked this change. Re-plan or request specific changes.',
  post_merge_failed: 'Checks failed after merging. Consider reverting and creating a follow-up story.',
  interrupted: 'Work was interrupted (restart or stop). Resume to continue.',
  invalid_agent_output: 'The agent returned output that failed validation. Retry or switch models.',
  model_limit: 'The prompt exceeds the model context. Choose a larger-context model.',
  environment: 'A required tool, disk space, or the repository path is unavailable. Fix it, then resume.',
};
