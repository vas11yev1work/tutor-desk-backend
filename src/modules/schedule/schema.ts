import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { id, timestamps } from '../../db/columns';
import { students } from '../students/schema';

export const LESSON_STATUSES = ['scheduled', 'cancelled'] as const;

/** Правило регулярных занятий в локальном времени репетитора. */
export const lessonSeries = sqliteTable('lesson_series', {
  id: id(),
  studentId: text('student_id')
    .notNull()
    .references(() => students.id),
  weekday: integer('weekday').notNull(), // 1–7, ISO (1 = понедельник)
  startTime: text('start_time').notNull(), // 'HH:MM'
  durationMin: integer('duration_min').notNull(),
  timezone: text('timezone').notNull(), // IANA, пояс браузера репетитора при создании
  startsOn: text('starts_on').notNull(), // 'YYYY-MM-DD'
  endsOn: text('ends_on'), // 'YYYY-MM-DD' включительно; null — бессрочно
  ...timestamps,
});

/** Конкретные занятия; к ним потом цепляются домашки. */
export const lessons = sqliteTable(
  'lessons',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id),
    seriesId: text('series_id').references(() => lessonSeries.id), // null — разовое
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    durationMin: integer('duration_min').notNull(),
    status: text('status', { enum: LESSON_STATUSES }).notNull().default('scheduled'),
    originalStartsAt: integer('original_starts_at', { mode: 'timestamp_ms' }), // время по правилу
    isModified: integer('is_modified', { mode: 'boolean' }).notNull().default(false), // переносили вручную
    ...timestamps,
  },
  t => [
    index('lessons_starts_at_idx').on(t.startsAt),
    index('lessons_student_starts_at_idx').on(t.studentId, t.startsAt),
    uniqueIndex('lessons_series_original_uq').on(t.seriesId, t.originalStartsAt),
  ],
);

export type Series = typeof lessonSeries.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
