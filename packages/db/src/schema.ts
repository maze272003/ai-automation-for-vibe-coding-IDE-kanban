import {
  BLOCKED_REASON, PLANNING_STATUS, PRIORITY, ROLE, STORY_STATUS,
  type PlanV1, type ProjectSettings, type ReviewV1,
} from '@aik/contracts';
import { sql } from 'drizzle-orm';
import {
  check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type { ChecksSummary, OutboxPayload, ProbeResult, QuotaState, ReviewsSummary, StoryEventPayload } from './json-types.ts';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const shaOk = (col: string) => `(${col} IS NULL OR length(${col}) IN (40, 64))`;

export const JOB_KINDS = ['plan', 'implement', 'verify', 'review', 'publish', 'merge', 'postmerge', 'pr_poll', 'fetch', 'clone', 'cleanup', 'retention'] as const;
export const JOB_SLOTS = ['heavy', 'light'] as const;
/**
 * A job lane — the unit of concurrency. `heavy` and `light` are the base lanes; a heavy lane
 * may be narrowed per repository (`heavy:repo:<hash>`) so independent repositories run in
 * parallel while one repository stays serialized.
 */
export type JobSlot = string;
export const JOB_STATUSES = ['queued', 'leased', 'succeeded', 'failed', 'dead', 'cancelled'] as const;

// ───────────── Projects & GitHub ─────────────
export const githubConnections = sqliteTable('github_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubUserId: integer('github_user_id').notNull(),
  login: text('login').notNull(),
  appClientId: text('app_client_id').notNull(),
  tokenRef: text('token_ref').notNull(),
  accessExpiresAt: ts('access_expires_at'),
  refreshExpiresAt: ts('refresh_expires_at'),
  status: text('status', { enum: ['connected', 'expired', 'revoked', 'disconnected', 'error'] }).notNull(),
  grantedPermissions: text('granted_permissions', { mode: 'json' }).$type<Record<string, string>>(),
  lastValidatedAt: ts('last_validated_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [uniqueIndex('gh_conn_user_uq').on(t.githubUserId)]);

export const repositoryConnections = sqliteTable('repository_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubConnectionId: integer('github_connection_id').notNull().references(() => githubConnections.id, { onDelete: 'cascade' }),
  githubRepoId: integer('github_repo_id').notNull(),
  installationId: integer('installation_id'),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  defaultBranch: text('default_branch').notNull(),
  visibility: text('visibility', { enum: ['public', 'private', 'internal'] }).notNull(),
  permissions: text('permissions', { mode: 'json' }).$type<{ admin: boolean; push: boolean; pull: boolean }>(),
  localPath: text('local_path'),
  etag: text('etag'),
  lastSyncedAt: ts('last_synced_at'),
}, (t) => [
  uniqueIndex('repo_conn_uq').on(t.githubConnectionId, t.githubRepoId),
  index('repo_conn_name_idx').on(t.owner, t.name),
]);

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull(),
  baseBranch: text('base_branch').notNull(),
  remoteUrl: text('remote_url'),
  repositoryConnectionId: integer('repository_connection_id').references(() => repositoryConnections.id, { onDelete: 'set null' }),
  settings: text('settings', { mode: 'json' }).$type<ProjectSettings>().notNull(),
  nextStoryNumber: integer('next_story_number').notNull().default(1),
  status: text('status', { enum: ['active', 'unavailable', 'archived'] }).notNull().default('active'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [uniqueIndex('projects_key_uq').on(t.key), uniqueIndex('projects_repo_uq').on(t.repoPath)]);

// ───────────── Stories ─────────────
export const userStories = sqliteTable('user_stories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  key: text('key').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  priority: text('priority', { enum: PRIORITY }).notNull().default('P2'),
  rank: integer('rank').notNull(),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  complexity: text('complexity', { enum: ['S', 'M', 'L', 'XL'] }),
  revision: integer('revision').notNull().default(1),
  status: text('status', { enum: STORY_STATUS }).notNull().default('NEW'),
  statusVersion: integer('status_version').notNull().default(0),
  planningStatus: text('planning_status', { enum: PLANNING_STATUS }).notNull().default('none'),
  activePlanId: integer('active_plan_id').references((): AnySQLiteColumn => plans.id),
  hold: integer('hold', { mode: 'boolean' }).notNull().default(false),
  blockedReason: text('blocked_reason', { enum: BLOCKED_REASON }),
  blockedFrom: text('blocked_from', { enum: STORY_STATUS }),
  blockedDetail: text('blocked_detail'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  activeRunId: integer('active_run_id').references((): AnySQLiteColumn => agentRuns.id),
  branchName: text('branch_name'),
  baseSha: text('base_sha'),
  candidateSha: text('candidate_sha'),
  candidateTree: text('candidate_tree'),
  mergedSha: text('merged_sha'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  doneAt: ts('done_at'),
  cancelledAt: ts('cancelled_at'),
}, (t) => [
  uniqueIndex('story_key_uq').on(t.projectId, t.key),
  index('story_board_idx').on(t.projectId, t.status, t.rank),
  check('story_sha_ck', sql.raw(`${shaOk('base_sha')} AND ${shaOk('candidate_sha')} AND ${shaOk('candidate_tree')} AND ${shaOk('merged_sha')}`)),
  check('story_blocked_ck', sql.raw(`(status = 'BLOCKED') = (blocked_reason IS NOT NULL)`)),
]);

export const storyDependencies = sqliteTable('story_dependencies', {
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  dependsOnStoryId: integer('depends_on_story_id').notNull().references(() => userStories.id),
}, (t) => [
  primaryKey({ columns: [t.storyId, t.dependsOnStoryId] }),
  check('dep_self_ck', sql.raw('story_id <> depends_on_story_id')),
]);

export const acceptanceCriteria = sqliteTable('acceptance_criteria', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  storyRevision: integer('story_revision').notNull(),
  ordinal: integer('ordinal').notNull(),
  text: text('text').notNull(),
  source: text('source', { enum: ['human', 'planner'] }).notNull(),
  supersededAt: ts('superseded_at'),
  createdAt: ts('created_at').notNull(),
}, (t) => [uniqueIndex('ac_uq').on(t.storyId, t.storyRevision, t.ordinal)]);

export const plans = sqliteTable('plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  storyRevision: integer('story_revision').notNull(),
  agentRunId: integer('agent_run_id').references((): AnySQLiteColumn => agentRuns.id),
  content: text('content', { mode: 'json' }).$type<PlanV1>().notNull(),
  status: text('status', { enum: ['proposed', 'approved', 'rejected', 'superseded'] }).notNull(),
  approvedBy: text('approved_by', { enum: ['human', 'auto'] }),
  approvedAt: ts('approved_at'),
  rejectionFeedback: text('rejection_feedback'),
  createdAt: ts('created_at').notNull(),
}, (t) => [uniqueIndex('plan_ver_uq').on(t.storyId, t.version)]);

export const clarifications = sqliteTable('clarifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: integer('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  question: text('question').notNull(),
  answer: text('answer'),
  answeredAt: ts('answered_at'),
}, (t) => [uniqueIndex('clar_uq').on(t.planId, t.ordinal)]);

// ───────────── Execution ─────────────
export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  kind: text('kind', { enum: ['story', 'review', 'verify', 'postmerge'] }).notNull(),
  path: text('path').notNull(),
  branch: text('branch'),
  headSha: text('head_sha'),
  status: text('status', { enum: ['active', 'preserved', 'removed'] }).notNull(),
  createdAt: ts('created_at').notNull(),
  removedAt: ts('removed_at'),
}, (t) => [
  uniqueIndex('ws_path_active_uq').on(t.path).where(sql.raw(`status <> 'removed'`)),
  check('ws_sha_ck', sql.raw(shaOk('head_sha'))),
]);

export const providers = sqliteTable('providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  presetKey: text('preset_key'),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['ollama', 'openai_compatible'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  keyRef: text('key_ref'),
  costClass: text('cost_class', { enum: ['local', 'free', 'free_limited', 'paid_flat', 'paid_metered'] }).notNull(),
  dataUse: text('data_use', { enum: ['no_training', 'may_train', 'unknown'] }).notNull(),
  termsUrl: text('terms_url'),
  termsCheckedAt: ts('terms_checked_at'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  quotaState: text('quota_state', { mode: 'json' }).$type<QuotaState>(),
});

export const modelProfiles = sqliteTable('model_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: integer('provider_id').notNull().references((): AnySQLiteColumn => providers.id),
  modelId: text('model_id').notNull(),
  family: text('family'),
  contextLimit: integer('context_limit').notNull(),
  outputLimit: integer('output_limit').notNull(),
  probe: text('probe', { mode: 'json' }).$type<ProbeResult>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
}, (t) => [uniqueIndex('mp_uq').on(t.providerId, t.modelId)]);

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  role: text('role', { enum: ROLE }).notNull(),
  attempt: integer('attempt').notNull(),
  modelProfileId: integer('model_profile_id').references(() => modelProfiles.id),
  promptVersion: text('prompt_version').notNull(),
  opencodeVersion: text('opencode_version').notNull(),
  opencodeSessionId: text('opencode_session_id'),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
  inputSha: text('input_sha'),
  resultSha: text('result_sha'),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'timed_out', 'cancelled'] }).notNull(),
  failureClass: text('failure_class', { enum: ['agent', 'infrastructure'] }),
  exitReason: text('exit_reason'),
  usage: text('usage', { mode: 'json' }).$type<{ requests: number; inTok: number; outTok: number }>(),
  logPath: text('log_path'),
  idempotencyKey: text('idempotency_key').notNull(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
}, (t) => [
  uniqueIndex('run_idem_uq').on(t.idempotencyKey),
  index('run_story_idx').on(t.storyId, t.role, t.attempt),
  check('run_sha_ck', sql.raw(`${shaOk('input_sha')} AND ${shaOk('result_sha')}`)),
]);

export const verificationRuns = sqliteTable('verification_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  commitSha: text('commit_sha').notNull(),
  trigger: text('trigger', { enum: ['candidate', 'postmerge', 'cleanroom'] }).notNull(),
  status: text('status', { enum: ['running', 'passed', 'failed', 'error'] }).notNull(),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [
  index('vr_story_sha_idx').on(t.storyId, t.commitSha),
  check('vr_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const verificationChecks = sqliteTable('verification_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  verificationRunId: integer('verification_run_id').notNull().references(() => verificationRuns.id),
  checkKey: text('check_key').notNull(),
  mandatory: integer('mandatory', { mode: 'boolean' }).notNull(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status', { enum: ['passed', 'failed', 'error', 'timed_out', 'skipped', 'unsupported'] }).notNull(),
  exitCode: integer('exit_code'),
  outputTail: text('output_tail'),
  logPath: text('log_path'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at').notNull(),
}, (t) => [uniqueIndex('vc_uq').on(t.verificationRunId, t.checkKey)]);

export const reviews = sqliteTable('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  commitSha: text('commit_sha').notNull(),
  actor: text('actor', { enum: ['agent', 'human'] }).notNull(),
  agentRunId: integer('agent_run_id').references(() => agentRuns.id),
  rawVerdict: text('raw_verdict', { enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] }).notNull(),
  verdict: text('verdict', { enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] }).notNull(),
  normalizationNote: text('normalization_note'),
  summary: text('summary').notNull(),
  raw: text('raw', { mode: 'json' }).$type<ReviewV1>().notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('review_story_sha_idx').on(t.storyId, t.commitSha),
  check('review_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const reviewFindings = sqliteTable('review_findings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reviewId: integer('review_id').notNull().references(() => reviews.id),
  findingKey: text('finding_key').notNull(),
  severity: text('severity', { enum: ['critical', 'high', 'medium', 'low', 'info'] }).notNull(),
  category: text('category').notNull(),
  filePath: text('file_path'),
  lineStart: integer('line_start'),
  lineEnd: integer('line_end'),
  evidence: text('evidence').notNull(),
  explanation: text('explanation').notNull(),
  recommendation: text('recommendation').notNull(),
  blocking: integer('blocking', { mode: 'boolean' }).notNull(),
  /** False when the cited file is neither in the reviewed diff nor the repository (spec §19.4 `unverified_location`). */
  locationVerified: integer('location_verified', { mode: 'boolean' }).notNull().default(true),
  priorFindingId: integer('prior_finding_id').references((): AnySQLiteColumn => reviewFindings.id),
  resolution: text('resolution', { enum: ['resolved', 'unresolved', 'disputed'] }),
}, (t) => [uniqueIndex('rf_uq').on(t.reviewId, t.findingKey)]);

export const reviewAcResults = sqliteTable('review_ac_results', {
  reviewId: integer('review_id').notNull().references(() => reviews.id),
  acceptanceCriterionId: integer('acceptance_criterion_id').notNull().references(() => acceptanceCriteria.id),
  status: text('status', { enum: ['met', 'unmet', 'unclear'] }).notNull(),
  evidence: text('evidence').notNull(),
}, (t) => [primaryKey({ columns: [t.reviewId, t.acceptanceCriterionId] })]);

// ───────────── Approvals, merges, PRs ─────────────
export const mergeApprovals = sqliteTable('merge_approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  kind: text('kind', { enum: ['publish', 'merge', 'override_remote_review'] }).notNull(),
  commitSha: text('commit_sha').notNull(),
  approver: text('approver').notNull().default('local-user'),
  note: text('note'),
  approvedAt: ts('approved_at').notNull(),
}, (t) => [
  uniqueIndex('ma_uq').on(t.storyId, t.kind, t.commitSha),
  check('ma_sha_ck', sql.raw(shaOk('commit_sha'))),
]);

export const pullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  repositoryConnectionId: integer('repository_connection_id').notNull().references(() => repositoryConnections.id),
  number: integer('number').notNull(),
  url: text('url').notNull(),
  headBranch: text('head_branch').notNull(),
  headSha: text('head_sha').notNull(),
  baseBranch: text('base_branch').notNull(),
  state: text('state', { enum: ['open', 'closed', 'merged'] }).notNull(),
  mergeable: integer('mergeable', { mode: 'boolean' }),
  checksSummary: text('checks_summary', { mode: 'json' }).$type<ChecksSummary>(),
  reviewsSummary: text('reviews_summary', { mode: 'json' }).$type<ReviewsSummary>(),
  mergeCommitSha: text('merge_commit_sha'),
  etag: text('etag'),
  lastPolledAt: ts('last_polled_at'),
}, (t) => [
  uniqueIndex('pr_uq').on(t.repositoryConnectionId, t.number),
  index('pr_story_idx').on(t.storyId),
  check('pr_sha_ck', sql.raw(`${shaOk('head_sha')} AND ${shaOk('merge_commit_sha')}`)),
]);

export const merges = sqliteTable('merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  method: text('method', { enum: ['local_merge', 'local_squash', 'github_merge', 'github_squash', 'github_external'] }).notNull(),
  approvedSha: text('approved_sha').notNull(),
  baseBefore: text('base_before'),
  baseAfter: text('base_after'),
  mergedSha: text('merged_sha'),
  pullRequestId: integer('pull_request_id').references(() => pullRequests.id),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  error: text('error'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (_t) => [check('merge_sha_ck', sql.raw(`${shaOk('approved_sha')} AND ${shaOk('base_before')} AND ${shaOk('base_after')} AND ${shaOk('merged_sha')}`))]);

export const remoteSyncRuns = sqliteTable('remote_sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['clone', 'fetch', 'push', 'pr_create', 'pr_poll', 'merge'] }).notNull(),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  shaBefore: text('sha_before'),
  shaAfter: text('sha_after'),
  detail: text('detail'),
  startedAt: ts('started_at').notNull(),
  endedAt: ts('ended_at'),
}, (t) => [index('rsr_project_idx').on(t.projectId, t.startedAt)]);

// ───────────── Routing & Usage ─────────────

export const roleRoutes = sqliteTable('role_routes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').references(() => projects.id),
  role: text('role', { enum: ROLE }).notNull(),
  position: integer('position').notNull(),
  modelProfileId: integer('model_profile_id').notNull().references(() => modelProfiles.id),
}, (t) => [uniqueIndex('rr_uq').on(t.projectId, t.role, t.position)]);

export const modelUsage = sqliteTable('model_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentRunId: integer('agent_run_id').references(() => agentRuns.id),
  modelProfileId: integer('model_profile_id').notNull().references(() => modelProfiles.id),
  httpStatus: integer('http_status').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms').notNull(),
  fallbackFrom: integer('fallback_from').references(() => modelProfiles.id),
  createdAt: ts('created_at').notNull(),
}, (t) => [index('mu_profile_time_idx').on(t.modelProfileId, t.createdAt)]);

// ───────────── System ─────────────
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const storyEvents = sqliteTable('story_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyId: integer('story_id').notNull().references(() => userStories.id),
  type: text('type').notNull(),
  fromStatus: text('from_status', { enum: STORY_STATUS }),
  toStatus: text('to_status', { enum: STORY_STATUS }),
  actor: text('actor').notNull(),
  payload: text('payload', { mode: 'json' }).$type<StoryEventPayload>(),
  idempotencyKey: text('idempotency_key'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('se_story_idx').on(t.storyId, t.id),
  uniqueIndex('se_idem_uq').on(t.idempotencyKey).where(sql.raw('idempotency_key IS NOT NULL')),
]);

export const outboxEvents = sqliteTable('outbox_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  topic: text('topic').notNull(),
  storyId: integer('story_id'),
  payload: text('payload', { mode: 'json' }).$type<OutboxPayload>().notNull(),
  createdAt: ts('created_at').notNull(),
});

export const durableJobs = sqliteTable('durable_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: JOB_KINDS }).notNull(),
  slot: text('slot').notNull(),
  storyId: integer('story_id').references(() => userStories.id),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  sideEffecting: integer('side_effecting', { mode: 'boolean' }).notNull(),
  status: text('status', { enum: JOB_STATUSES }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAfter: ts('run_after').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: ts('lease_expires_at'),
  heartbeatAt: ts('heartbeat_at'),
  idempotencyKey: text('idempotency_key').notNull(),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  uniqueIndex('job_idem_uq').on(t.idempotencyKey),
  index('job_claim_idx').on(t.status, t.slot, t.runAfter),
]);

export const apiIdempotency = sqliteTable('api_idempotency', {
  key: text('key').primaryKey(),
  route: text('route').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status').notNull(),
  responseBody: text('response_body', { mode: 'json' }),
  createdAt: ts('created_at').notNull(),
});

/** Audit tables made append-only by triggers in migration 0001. */
export const IMMUTABLE_TABLES = [
  'story_events', 'reviews', 'review_findings', 'review_ac_results', 'verification_checks', 'merge_approvals',
] as const;
