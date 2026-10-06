DROP TABLE `kaneo_task`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_status_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`actor_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_status_change`("id", "request_id", "from_status", "to_status", "actor_id", "created_at") SELECT "id", "request_id", "from_status", "to_status", "actor_id", "created_at" FROM `status_change`;--> statement-breakpoint
DROP TABLE `status_change`;--> statement-breakpoint
ALTER TABLE `__new_status_change` RENAME TO `status_change`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `status_change_request_idx` ON `status_change` (`request_id`,`id`);