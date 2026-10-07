import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { id, timestamps } from '../../db/columns';
import { lessons } from '../schedule/schema';
import { students } from '../students/schema';

export const ASSIGNMENT_KINDS = ['homework', 'mock'] as const;

/**
 * PDF-задания: домашки и пробники. Файл лежит в R2 по ключу fileKey(row).
 * Удаляются каскадом вместе с занятием или учеником; осиротевшие файлы в R2 подчищает cron.
 */
export const assignments = sqliteTable(
  'assignments',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    // Домашка всегда у занятия; пробник — у занятия или сам по себе.
    lessonId: text('lesson_id').references(() => lessons.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ASSIGNMENT_KINDS }).notNull(),
    fileName: text('file_name').notNull(),
    size: integer('size').notNull(),
    ...timestamps,
  },
  t => [index('assignments_lesson_idx').on(t.lessonId), index('assignments_student_idx').on(t.studentId)],
);

export type Assignment = typeof assignments.$inferSelect;

export const FILES_PREFIX = 'students/';
export const fileKey = (a: Pick<Assignment, 'id' | 'studentId'>) => `${FILES_PREFIX}${a.studentId}/${a.id}.pdf`;
