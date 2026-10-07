-- SQLite не умеет ADD COLUMN NOT NULL без DEFAULT: пересоздаём students, существующим строкам
-- выдаём случайный access_token и текущее время.
CREATE TABLE `__new_students` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`grade` integer,
	`exam` text,
	`contact` text,
	`notes` text,
	`access_token` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_students` (`id`, `name`, `access_token`, `created_at`, `updated_at`)
SELECT `id`, `name`, lower(hex(randomblob(12))), CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `students`;
--> statement-breakpoint
DROP TABLE `students`;--> statement-breakpoint
ALTER TABLE `__new_students` RENAME TO `students`;--> statement-breakpoint
CREATE UNIQUE INDEX `students_access_token_unique` ON `students` (`access_token`);--> statement-breakpoint
CREATE TABLE `lesson_series` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`duration_min` integer NOT NULL,
	`timezone` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`series_id` text,
	`starts_at` integer NOT NULL,
	`duration_min` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`original_starts_at` integer,
	`is_modified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`series_id`) REFERENCES `lesson_series`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lessons_starts_at_idx` ON `lessons` (`starts_at`);--> statement-breakpoint
CREATE INDEX `lessons_student_starts_at_idx` ON `lessons` (`student_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `lessons_series_original_uq` ON `lessons` (`series_id`,`original_starts_at`);
