CREATE TABLE `office_rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_path_norm` text NOT NULL,
	`project_id` integer,
	`project_key_snapshot` text NOT NULL,
	`project_name_snapshot` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`wing` text,
	`slot_index` integer,
	`side` text,
	`customization` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `office_rooms_repo_uq` ON `office_rooms` (`repo_path_norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `office_rooms_slot_uq` ON `office_rooms` (`wing`,`slot_index`,`side`) WHERE wing IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `office_rooms_project_uq` ON `office_rooms` (`project_id`) WHERE project_id IS NOT NULL;