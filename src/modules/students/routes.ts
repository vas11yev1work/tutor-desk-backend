import { sValidator } from '@hono/standard-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';

import { type Db, getDb } from '../../db';
import { ApiError, notFound } from '../../lib/errors';
import { onInvalid, rangeQuery } from '../../lib/validation';
import { listMocks } from '../assignments/service';
import { deleteStudent, listActiveSeries, listLessons } from '../schedule/service';
import { themeField } from '../settings/routes';
import { coverResponse, deleteCoverFile, setCover } from './cover';
import { EXAMS, students } from './schema';
import { createStudent, updateStudent } from './service';
import { newAccessToken } from './token';

const optionalText = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max))));

/**
 * Контакт — Telegram-юзернейм без @: фронт и виджеты сами строят из него @label и ссылку t.me.
 * Чистим то, что пишут люди и Claude: «Telegram: @vera_tg», «tg vera_tg», «https://t.me/vera_tg» → «vera_tg».
 */
export const telegramUsername = (contact: string) =>
  contact
    .trim()
    .replace(/^(telegram|телеграм|tg|тг)\s*:?\s*/i, '')
    .replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .trim() || null;

export const studentFields = {
  name: v.pipe(v.string(), v.trim(), v.nonEmpty('Имя обязательно'), v.maxLength(200)),
  grade: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(11)))),
  exam: v.optional(v.nullable(v.picklist(EXAMS))),
  contact: v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.maxLength(500),
        v.transform(telegramUsername),
        v.description('Telegram-юзернейм без @ и без «Telegram:», например vera_tg'),
      ),
    ),
  ),
  notes: optionalText(5000),
};

// Тема — только из кабинета, в MCP-инструменты studentFields она не попадает.
const adminStudentFields = { ...studentFields, theme: v.optional(themeField) };

const getStudent = async (db: Db, id: string) => {
  const student = await db.select().from(students).where(eq(students.id, id)).get();
  if (!student) throw notFound('Ученик не найден');
  return student;
};

export const studentsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async c => c.json(await getDb(c.env).select().from(students).orderBy(desc(students.createdAt))))
  .post('/', sValidator('json', v.object(adminStudentFields), onInvalid), async c =>
    c.json(await createStudent(getDb(c.env), c.req.valid('json')), 201),
  )
  .get('/:id', async c => c.json(await getStudent(getDb(c.env), c.req.param('id'))))
  .patch('/:id', sValidator('json', v.partial(v.object(adminStudentFields)), onInvalid), async c =>
    c.json(await updateStudent(getDb(c.env), c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', async c => {
    const db = getDb(c.env);
    const student = await getStudent(db, c.req.param('id'));
    await deleteStudent(db, student.id);
    await deleteCoverFile(c.env.FILES, student);
    return c.body(null, 204);
  })
  .get('/:id/cover', async c => coverResponse(c.env.FILES, await getStudent(getDb(c.env), c.req.param('id'))))
  // multipart/form-data, поле `file`: JPEG, PNG или WebP; старая обложка удаляется.
  .put('/:id/cover', async c => {
    const { file } = await c.req.parseBody();
    if (!(file instanceof File)) throw new ApiError(400, 'validation_error', 'file: нужен файл');
    return c.json(await setCover(getDb(c.env), c.env.FILES, c.req.param('id'), file));
  })
  .delete('/:id/cover', async c => c.json(await setCover(getDb(c.env), c.env.FILES, c.req.param('id'), null)))
  // Имя в ссылке — текущее: после переименования новая ссылка будет уже с новым именем.
  .post('/:id/regenerate-token', async c => {
    const db = getDb(c.env);
    const { id, name } = await getStudent(db, c.req.param('id'));
    const [student] = await db
      .update(students)
      .set({ accessToken: newAccessToken(name) })
      .where(eq(students.id, id))
      .returning();
    return c.json(student);
  })
  .get('/:id/lessons', sValidator('query', rangeQuery, onInvalid), async c => {
    const db = getDb(c.env);
    const { id } = await getStudent(db, c.req.param('id'));
    return c.json(await listLessons(db, { ...c.req.valid('query'), studentId: id }));
  })
  .get('/:id/mocks', async c => {
    const db = getDb(c.env);
    const { id } = await getStudent(db, c.req.param('id'));
    return c.json(await listMocks(db, id));
  })
  .get('/:id/series', async c => {
    const db = getDb(c.env);
    const { id } = await getStudent(db, c.req.param('id'));
    return c.json(await listActiveSeries(db, id, Date.now()));
  });
