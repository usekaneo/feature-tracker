-- "Shipped" became "Released" when progress started following GitHub releases.
UPDATE `request` SET `status` = 'released' WHERE `status` = 'shipped';
--> statement-breakpoint
UPDATE `status_change` SET `from_status` = 'released' WHERE `from_status` = 'shipped';
--> statement-breakpoint
UPDATE `status_change` SET `to_status` = 'released' WHERE `to_status` = 'shipped';
