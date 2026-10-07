-- Архив заменён полным удалением: уже архивных учеников удаляем вместе с правилами и занятиями,
-- иначе после DROP COLUMN они снова появятся в списке.
DELETE FROM `lessons` WHERE `student_id` IN (SELECT `id` FROM `students` WHERE `archived_at` IS NOT NULL);--> statement-breakpoint
DELETE FROM `lesson_series` WHERE `student_id` IN (SELECT `id` FROM `students` WHERE `archived_at` IS NOT NULL);--> statement-breakpoint
DELETE FROM `students` WHERE `archived_at` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `archived_at`;
