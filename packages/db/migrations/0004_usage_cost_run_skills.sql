CREATE TABLE `model_usage_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_run_id` integer,
	`model_profile_id` integer,
	`http_status` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer,
	`fallback_from` integer,
	`created_at` integer NOT NULL,
	`runtime` text DEFAULT 'opencode' NOT NULL,
	`model_slug` text,
	`effort` text,
	`cost_usd` real,
	`cached_input_tokens` integer,
	`duration_ms` integer,
	`cost_source` text DEFAULT 'unknown' NOT NULL,
	`story_id` integer,
	`project_id` integer,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_profile_id`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fallback_from`) REFERENCES `model_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `model_usage_new` (`id`, `agent_run_id`, `model_profile_id`, `http_status`, `input_tokens`, `output_tokens`, `latency_ms`, `fallback_from`, `created_at`) SELECT `id`, `agent_run_id`, `model_profile_id`, `http_status`, `input_tokens`, `output_tokens`, `latency_ms`, `fallback_from`, `created_at` FROM `model_usage`;--> statement-breakpoint
DROP TABLE `model_usage`;--> statement-breakpoint
ALTER TABLE `model_usage_new` RENAME TO `model_usage`;--> statement-breakpoint
CREATE INDEX `mu_profile_time_idx` ON `model_usage` (`model_profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mu_project_time_idx` ON `model_usage` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mu_story_idx` ON `model_usage` (`story_id`);--> statement-breakpoint
CREATE TABLE `run_skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_run_id` integer NOT NULL,
	`skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`content_sha256` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rs_run_skill_uq` ON `run_skills` (`agent_run_id`,`skill_id`);
