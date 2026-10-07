import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';

import { id, timestamps } from '../../db/columns';

// null — ученик без экзамена: пробники и аналитика ему не нужны.
export const EXAMS = ['oge', 'ege_profile', 'ege_base'] as const;

export const newAccessToken = () => nanoid(24);

export const students = sqliteTable('students', {
  id: id(),
  name: text('name').notNull(),
  // 1–11; null — взрослые/студенты.
  grade: integer('grade'),
  exam: text('exam', { enum: EXAMS }),
  contact: text('contact'),
  notes: text('notes'),
  // Личная ссылка ученика: /api/s/:token.
  accessToken: text('access_token').notNull().unique().$defaultFn(newAccessToken),
  ...timestamps,
});

export type Student = typeof students.$inferSelect;
