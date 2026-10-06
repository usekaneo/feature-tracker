CREATE TABLE `changelog_release` (
	`tag` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`version` text NOT NULL,
	`url` text NOT NULL,
	`published_at` integer NOT NULL,
	`source_body` text NOT NULL,
	`body` text NOT NULL,
	`body_html` text NOT NULL,
	`notes_built_at` integer,
	`synced_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `changelog_release_product_idx` ON `changelog_release` (`product`,`published_at`);