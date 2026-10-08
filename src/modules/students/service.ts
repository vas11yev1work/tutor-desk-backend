import { eq } from 'drizzle-orm';

import type { Db } from '../../db';
import { notFound } from '../../lib/errors';
import { type Student, students } from './schema';
import { newAccessToken } from './token';

type StudentInput = Pick<Student, 'name'> & Partial<Pick<Student, 'grade' | 'exam' | 'contact' | 'notes'>>;

export const createStudent = (db: Db, input: StudentInput) =>
  db
    .insert(students)
    .values({ ...input, accessToken: newAccessToken(input.name) })
    .returning()
    .get();

export const updateStudent = async (db: Db, id: string, patch: Partial<StudentInput>) => {
  const [student] = await db.update(students).set(patch).where(eq(students.id, id)).returning();
  if (!student) throw notFound('Ученик не найден');
  return student;
};
