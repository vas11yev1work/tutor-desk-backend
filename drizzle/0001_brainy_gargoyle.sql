CREATE TABLE `login_attempts` (
	`ip` text PRIMARY KEY NOT NULL,
	`failed_count` integer NOT NULL,
	`first_failed_at` integer NOT NULL,
	`blocked_until` integer
);
