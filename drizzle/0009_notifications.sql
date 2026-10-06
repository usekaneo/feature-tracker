CREATE TABLE `notification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`request_id` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`comment_id` integer,
	`from_status` text,
	`to_status` text,
	`read_at` integer,
	`email_state` text,
	`email_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_user_idx` ON `notification` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `notification_unread_idx` ON `notification` (`user_id`,`request_id`) WHERE read_at is null;--> statement-breakpoint
CREATE INDEX `notification_email_idx` ON `notification` (`id`) WHERE email_state = 'pending';--> statement-breakpoint
CREATE INDEX `notification_request_idx` ON `notification` (`request_id`);--> statement-breakpoint
CREATE INDEX `notification_created_idx` ON `notification` (`created_at`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`request_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`request_id`, `user_id`),
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscription_user_idx` ON `subscription` (`user_id`);--> statement-breakpoint
ALTER TABLE `user` ADD `email_on_status` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `email_on_comment` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing authors, voters and commenters follow their requests, as new ones do.
INSERT OR IGNORE INTO `subscription` (`request_id`, `user_id`, `created_at`) SELECT `id`, `author_id`, `created_at` FROM `request`;--> statement-breakpoint
INSERT OR IGNORE INTO `subscription` (`request_id`, `user_id`, `created_at`) SELECT `request_id`, `user_id`, `created_at` FROM `vote`;--> statement-breakpoint
INSERT OR IGNORE INTO `subscription` (`request_id`, `user_id`, `created_at`) SELECT `request_id`, `author_id`, min(`created_at`) FROM `comment` GROUP BY `request_id`, `author_id`;
