import { sValidator } from '@hono/standard-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';

import { type Db, getDb } from '../../db';
import { notFound } from '../../lib/errors';
import { onInvalid, rangeQuery } from '../../lib/validation';
import { deleteStudent, listLessons } from '../schedule/service';
import { EXAMS, newAccessToken, students } from './schema';

const optionalText = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max))));

const studentFields = {
  name: v.pipe(v.string(), v.trim(), v.nonEmpty('Имя обязательно'), v.maxLength(200)),
  grade: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(11)))),
  exam: v.optional(v.nullable(v.picklist(EXAMS))),
  contact: optionalText(500),
  notes: optionalText(5000),
};

const getStudent = async (db: Db, id: string) => {
  const student = await db.select().from(students).where(eq(students.id, id)).get();
  if (!student) throw notFound('Ученик не найден');
  return student;
};

export const studentsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async c => c.json(await getDb(c.env).select().from(students).orderBy(desc(students.createdAt))))
  .post('/', sValidator('json', v.object(studentFields), onInvalid), async c =>
    c.json(await getDb(c.env).insert(students).values(c.req.valid('json')).returning().get(), 201),
  )
  .get('/:id', async c => c.json(await getStudent(getDb(c.env), c.req.param('id'))))
  .patch('/:id', sValidator('json', v.partial(v.object(studentFields)), onInvalid), async c => {
    const [student] = await getDb(c.env)
      .update(students)
      .set(c.req.valid('json'))
      .where(eq(students.id, c.req.param('id')))
      .returning();
    if (!student) throw notFound('Ученик не найден');
    return c.json(student);
  })
  .delete('/:id', async c => {
    await deleteStudent(getDb(c.env), c.req.param('id'));
    return c.body(null, 204);
  })
  .post('/:id/regenerate-token', async c => {
    const [student] = await getDb(c.env)
      .update(students)
      .set({ accessToken: newAccessToken() })
      .where(eq(students.id, c.req.param('id')))
      .returning();
    if (!student) throw notFound('Ученик не найден');
    return c.json(student);
  })
  .get('/:id/lessons', sValidator('query', rangeQuery, onInvalid), async c => {
    const db = getDb(c.env);
    const { id } = await getStudent(db, c.req.param('id'));
    return c.json(await listLessons(db, { ...c.req.valid('query'), studentId: id }));
  });
