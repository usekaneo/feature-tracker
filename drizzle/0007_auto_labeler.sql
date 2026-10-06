CREATE TABLE `auto_label_job` (
	`request_id` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`lease_until` integer,
	`manual_override` integer DEFAULT false NOT NULL,
	`managed_label_ids` text DEFAULT '[]' NOT NULL,
	`assessment` text,
	`last_error` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auto_label_job_due_idx` ON `auto_label_job` (`state`,`next_attempt_at`);