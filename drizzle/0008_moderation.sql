CREATE TABLE `moderation_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text,
	`request_id` integer,
	`comment_id` integer,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `moderation_log_target_user_idx` ON `moderation_log` (`target_user_id`);--> statement-breakpoint
CREATE TABLE `report` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`comment_id` integer,
	`reporter_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`state` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_reporter_target_idx` ON `report` (`reporter_id`,`request_id`,coalesce(`comment_id`, 0));--> statement-breakpoint
CREATE INDEX `report_state_idx` ON `report` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `report_target_idx` ON `report` (`request_id`,`comment_id`);--> statement-breakpoint
ALTER TABLE `user` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;