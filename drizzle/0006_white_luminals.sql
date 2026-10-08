CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'lime' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `students` ADD `theme` text DEFAULT 'lime' NOT NULL;