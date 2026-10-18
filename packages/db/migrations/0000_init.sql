CREATE TABLE `acceptance_criteria` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`story_revision` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`superseded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ac_uq` ON `acceptance_criteria` (`story_id`,`story_revision`,`ordinal`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`role` text NOT NULL,
	`attempt` integer NOT NULL,
	`model_profile_id` integer,
	`prompt_version` text NOT NULL,
	`opencode_version` text NOT NULL,
	`opencode_session_id` text,
	`workspace_id` integer,
	`input_sha` text,
	`result_sha` text,
	`status` text NOT NULL,
	`failure_class` text,
	`exit_reason` text,
	`usage` text,
	`log_path` text,
	`idempotency_key` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_profile_id`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_sha_ck" CHECK((input_sha IS NULL OR length(input_sha) IN (40, 64)) AND (result_sha IS NULL OR length(result_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_idem_uq` ON `agent_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `run_story_idx` ON `agent_runs` (`story_id`,`role`,`attempt`);--> statement-breakpoint
CREATE TABLE `api_idempotency` (
	`key` text PRIMARY KEY NOT NULL,
	`route` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clarifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`answered_at` integer,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clar_uq` ON `clarifications` (`plan_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `durable_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`slot` text NOT NULL,
	`story_id` integer,
	`payload` text NOT NULL,
	`side_effecting` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`idempotency_key` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_idem_uq` ON `durable_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `job_claim_idx` ON `durable_jobs` (`status`,`slot`,`run_after`);--> statement-breakpoint
CREATE TABLE `github_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_user_id` integer NOT NULL,
	`login` text NOT NULL,
	`app_client_id` text NOT NULL,
	`token_ref` text NOT NULL,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`status` text NOT NULL,
	`granted_permissions` text,
	`last_validated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gh_conn_user_uq` ON `github_connections` (`github_user_id`);--> statement-breakpoint
CREATE TABLE `merge_approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`kind` text NOT NULL,
	`commit_sha` text NOT NULL,
	`approver` text DEFAULT 'local-user' NOT NULL,
	`note` text,
	`approved_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ma_sha_ck" CHECK((commit_sha IS NULL OR length(commit_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ma_uq` ON `merge_approvals` (`story_id`,`kind`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `merges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`method` text NOT NULL,
	`approved_sha` text NOT NULL,
	`base_before` text,
	`base_after` text,
	`merged_sha` text,
	`pull_request_id` integer,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merge_sha_ck" CHECK((approved_sha IS NULL OR length(approved_sha) IN (40, 64)) AND (base_before IS NULL OR length(base_before) IN (40, 64)) AND (base_after IS NULL OR length(base_after) IN (40, 64)) AND (merged_sha IS NULL OR length(merged_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE TABLE `model_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`family` text,
	`context_limit` integer NOT NULL,
	`output_limit` integer NOT NULL,
	`probe` text,
	`enabled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mp_uq` ON `model_profiles` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_run_id` integer,
	`model_profile_id` integer NOT NULL,
	`http_status` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`fallback_from` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_profile_id`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fallback_from`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mu_profile_time_idx` ON `model_usage` (`model_profile_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`story_id` integer,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`version` integer NOT NULL,
	`story_revision` integer NOT NULL,
	`agent_run_id` integer,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`rejection_feedback` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_ver_uq` ON `plans` (`story_id`,`version`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`remote_url` text,
	`repository_connection_id` integer,
	`settings` text NOT NULL,
	`next_story_number` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_connection_id`) REFERENCES `repository_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_key_uq` ON `projects` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_uq` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preset_key` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`key_ref` text,
	`cost_class` text NOT NULL,
	`data_use` text NOT NULL,
	`terms_url` text,
	`terms_checked_at` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`quota_state` text
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`repository_connection_id` integer NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`head_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_branch` text NOT NULL,
	`state` text NOT NULL,
	`mergeable` integer,
	`checks_summary` text,
	`reviews_summary` text,
	`merge_commit_sha` text,
	`etag` text,
	`last_polled_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_connection_id`) REFERENCES `repository_connections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pr_sha_ck" CHECK((head_sha IS NULL OR length(head_sha) IN (40, 64)) AND (merge_commit_sha IS NULL OR length(merge_commit_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_uq` ON `pull_requests` (`repository_connection_id`,`number`);--> statement-breakpoint
CREATE INDEX `pr_story_idx` ON `pull_requests` (`story_id`);--> statement-breakpoint
CREATE TABLE `remote_sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`sha_before` text,
	`sha_after` text,
	`detail` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rsr_project_idx` ON `remote_sync_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `repository_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_connection_id` integer NOT NULL,
	`github_repo_id` integer NOT NULL,
	`installation_id` integer,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_branch` text NOT NULL,
	`visibility` text NOT NULL,
	`permissions` text,
	`local_path` text,
	`etag` text,
	`last_synced_at` integer,
	FOREIGN KEY (`github_connection_id`) REFERENCES `github_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_conn_uq` ON `repository_connections` (`github_connection_id`,`github_repo_id`);--> statement-breakpoint
CREATE INDEX `repo_conn_name_idx` ON `repository_connections` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `review_ac_results` (
	`review_id` integer NOT NULL,
	`acceptance_criterion_id` integer NOT NULL,
	`status` text NOT NULL,
	`evidence` text NOT NULL,
	PRIMARY KEY(`review_id`, `acceptance_criterion_id`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acceptance_criterion_id`) REFERENCES `acceptance_criteria`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`finding_key` text NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`file_path` text,
	`line_start` integer,
	`line_end` integer,
	`evidence` text NOT NULL,
	`explanation` text NOT NULL,
	`recommendation` text NOT NULL,
	`blocking` integer NOT NULL,
	`prior_finding_id` integer,
	`resolution` text,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prior_finding_id`) REFERENCES `review_findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rf_uq` ON `review_findings` (`review_id`,`finding_key`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`actor` text NOT NULL,
	`agent_run_id` integer,
	`raw_verdict` text NOT NULL,
	`verdict` text NOT NULL,
	`normalization_note` text,
	`summary` text NOT NULL,
	`raw` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_sha_ck" CHECK((commit_sha IS NULL OR length(commit_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE INDEX `review_story_sha_idx` ON `reviews` (`story_id`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `role_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	`model_profile_id` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_profile_id`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rr_uq` ON `role_routes` (`project_id`,`role`,`position`);--> statement-breakpoint
CREATE TABLE `story_dependencies` (
	`story_id` integer NOT NULL,
	`depends_on_story_id` integer NOT NULL,
	PRIMARY KEY(`story_id`, `depends_on_story_id`),
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dep_self_ck" CHECK(story_id <> depends_on_story_id)
);
--> statement-breakpoint
CREATE TABLE `story_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`actor` text NOT NULL,
	`payload` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `se_story_idx` ON `story_events` (`story_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `se_idem_uq` ON `story_events` (`idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE `user_stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`rank` integer NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`complexity` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`status_version` integer DEFAULT 0 NOT NULL,
	`planning_status` text DEFAULT 'none' NOT NULL,
	`active_plan_id` integer,
	`hold` integer DEFAULT false NOT NULL,
	`blocked_reason` text,
	`blocked_from` text,
	`blocked_detail` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`active_run_id` integer,
	`branch_name` text,
	`base_sha` text,
	`candidate_sha` text,
	`candidate_tree` text,
	`merged_sha` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`done_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "story_sha_ck" CHECK((base_sha IS NULL OR length(base_sha) IN (40, 64)) AND (candidate_sha IS NULL OR length(candidate_sha) IN (40, 64)) AND (candidate_tree IS NULL OR length(candidate_tree) IN (40, 64)) AND (merged_sha IS NULL OR length(merged_sha) IN (40, 64))),
	CONSTRAINT "story_blocked_ck" CHECK((status = 'BLOCKED') = (blocked_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_key_uq` ON `user_stories` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `story_board_idx` ON `user_stories` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE TABLE `verification_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`verification_run_id` integer NOT NULL,
	`check_key` text NOT NULL,
	`mandatory` integer NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`output_tail` text,
	`log_path` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vc_uq` ON `verification_checks` (`verification_run_id`,`check_key`);--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vr_sha_ck" CHECK((commit_sha IS NULL OR length(commit_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE INDEX `vr_story_sha_idx` ON `verification_runs` (`story_id`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`branch` text,
	`head_sha` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ws_sha_ck" CHECK((head_sha IS NULL OR length(head_sha) IN (40, 64)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ws_path_active_uq` ON `workspaces` (`path`) WHERE status <> 'removed';