CREATE TABLE `github_issue` (
	`request_id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`ref` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`lease_until` integer,
	`last_error` text,
	`issue_number` integer,
	`issue_url` text,
	`pr_number` integer,
	`pr_url` text,
	`merge_sha` text,
	`merged_at` integer,
	`nightly_tag` text,
	`nightly_url` text,
	`release_tag` text,
	`release_url` text,
	`released_at` integer,
	`checked_at` integer,
	`check_error` text,
	`requested_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_issue_ref_unique` ON `github_issue` (`ref`);--> statement-breakpoint
CREATE INDEX `github_issue_due_idx` ON `github_issue` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `github_issue_tracking_idx` ON `github_issue` (`state`,`release_tag`,`checked_at`);