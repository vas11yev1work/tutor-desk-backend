import { sValidator } from '@hono/standard-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { type Db, getDb } from '../../db';
import { notFound } from '../../lib/errors';
import { onInvalid, rangeQuery } from '../../lib/validation';
import { EXAM_MAX_SCORES, sum } from '../assignments/scores';
import { fileResponse, listMocks } from '../assignments/service';
import { listLessons } from '../schedule/service';
import { students } from '../students/schema';

/** Ученик по личному токену; неверный токен или удалённый ученик → 404. */
const findStudent = async (db: Db, token: string) => {
  const student = await db
    .select({ id: students.id, name: students.name, grade: students.grade, exam: students.exam, theme: students.theme })
    .from(students)
    .where(eq(students.accessToken, token))
    .get();
  if (!student) throw notFound('Ученик не найден');
  return student;
};

/** Публичный контур ученика /api/s/:token — без cookie и auth-middleware, только GET. */
export const portalRoutes = new Hono<{ Bindings: Env }>()
  .get('/:token', async c => {
    const { id: _id, ...profile } = await findStudent(getDb(c.env), c.req.param('token'));
    // Максимальный первичный балл — для «16 / 32» у пробников.
    return c.json({ ...profile, examMax: profile.exam ? sum(EXAM_MAX_SCORES[profile.exam]) : null });
  })
  .get('/:token/lessons', sValidator('query', rangeQuery, onInvalid), async c => {
    const db = getDb(c.env);
    const { id } = await findStudent(db, c.req.param('token'));
    const rows = await listLessons(db, { ...c.req.valid('query'), studentId: id });
    return c.json(
      rows.map(l => ({
        id: l.id,
        startsAt: l.startsAt,
        originalStartsAt: l.originalStartsAt,
        durationMin: l.durationMin,
        status: l.status,
        assignments: l.assignments.map(a => ({ id: a.id, kind: a.kind, fileName: a.fileName })),
      })),
    );
  })
  .get('/:token/mocks', async c => {
    const db = getDb(c.env);
    const { id } = await findStudent(db, c.req.param('token'));
    return c.json(
      (await listMocks(db, id)).map(m => ({
        id: m.id,
        number: m.number,
        fileName: m.fileName,
        lessonStartsAt: m.lessonStartsAt,
        // Только итог после проверки; баллы по номерам и комментарий — для репетитора.
        total: m.total,
        createdAt: m.createdAt,
      })),
    );
  })
  .get('/:token/files/:id', async c => {
    const db = getDb(c.env);
    const { id } = await findStudent(db, c.req.param('token'));
    return fileResponse(db, c.env.FILES, c.req.param('id'), id);
  });
