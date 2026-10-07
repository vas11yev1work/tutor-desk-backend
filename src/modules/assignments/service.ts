import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Db } from '../../db';
import { ApiError, notFound } from '../../lib/errors';
import { lessons } from '../schedule/schema';
import { students } from '../students/schema';
import { type Assignment, assignments, fileKey, FILES_PREFIX } from './schema';
import { EXAM_MAX_SCORES, sum } from './scores';

export const MAX_FILE_MB = 20;

const noExam = () => new ApiError(409, 'no_exam', 'У ученика не выбран экзамен');
/** Файлы моложе часа cron не трогает: строка в БД пишется после загрузки в R2. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Поля задания в ответах API. */
export const publicAssignment = (a: Assignment) => ({
  id: a.id,
  kind: a.kind,
  lessonId: a.lessonId,
  fileName: a.fileName,
  size: a.size,
  createdAt: a.createdAt,
  scores: a.scores,
  total: a.scores ? sum(a.scores) : null,
  comment: a.comment,
});

const assertPdf = async (file: File) => {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new ApiError(413, 'file_too_large', `Файл больше ${MAX_FILE_MB} МБ`);
  }
  // Проверяем сигнатуру, а не только расширение: файл потом отдаётся ученику как application/pdf.
  if ((await file.slice(0, 5).text()) !== '%PDF-') throw new ApiError(400, 'not_pdf', 'Нужен PDF-файл');
};

export const uploadToLesson = async (
  db: Db,
  files: R2Bucket,
  lessonId: string,
  kind: Assignment['kind'],
  file: File,
) => {
  const lesson = await db
    .select({ studentId: lessons.studentId, exam: students.exam })
    .from(lessons)
    .innerJoin(students, eq(students.id, lessons.studentId))
    .where(eq(lessons.id, lessonId))
    .get();
  if (!lesson) throw notFound('Занятие не найдено');
  if (kind === 'mock' && !lesson.exam) throw noExam();
  await assertPdf(file);
  const row = {
    id: nanoid(),
    studentId: lesson.studentId,
    lessonId,
    kind,
    fileName: file.name || 'file.pdf',
    size: file.size,
  };
  await files.put(fileKey(row), file.stream(), { httpMetadata: { contentType: 'application/pdf' } });
  return publicAssignment(await db.insert(assignments).values(row).returning().get());
};

/** Пробники ученика по порядку загрузки; number — «Пробник N», lessonStartsAt — дата занятия, к которому выдан. */
export const listMocks = async (db: Db, studentId: string) => {
  const rows = await db
    .select({ assignment: assignments, lessonStartsAt: lessons.startsAt })
    .from(assignments)
    .innerJoin(lessons, eq(lessons.id, assignments.lessonId))
    .where(and(eq(assignments.studentId, studentId), eq(assignments.kind, 'mock')))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  return rows.map((r, i) => ({ ...publicAssignment(r.assignment), lessonStartsAt: r.lessonStartsAt, number: i + 1 }));
};

/** Баллы пробника по номерам заданий экзамена ученика; scores: null — снять оценку. */
export const scoreMock = async (db: Db, id: string, input: { scores: number[] | null; comment?: string | null }) => {
  const row = await db
    .select({ kind: assignments.kind, exam: students.exam })
    .from(assignments)
    .innerJoin(students, eq(students.id, assignments.studentId))
    .where(eq(assignments.id, id))
    .get();
  if (!row) throw notFound('Задание не найдено');
  if (row.kind !== 'mock') throw new ApiError(409, 'not_mock', 'Баллы ставятся только пробнику');
  // Экзамен могли убрать из профиля уже после выдачи пробника.
  if (!row.exam) throw noExam();
  const max = EXAM_MAX_SCORES[row.exam];
  if (input.scores && (input.scores.length !== max.length || input.scores.some((s, i) => s > (max[i] ?? 0)))) {
    throw new ApiError(400, 'invalid_scores', `Нужно ${max.length} баллов, максимум по номерам: ${max.join(', ')}`);
  }
  const [updated] = await db
    .update(assignments)
    .set({ scores: input.scores, ...(input.comment === undefined ? {} : { comment: input.comment }) })
    .where(eq(assignments.id, id))
    .returning();
  if (!updated) throw notFound('Задание не найдено');
  return publicAssignment(updated);
};

export const deleteAssignment = async (db: Db, files: R2Bucket, id: string) => {
  const [row] = await db.delete(assignments).where(eq(assignments.id, id)).returning();
  if (!row) throw notFound('Задание не найдено');
  await files.delete(fileKey(row));
};

/** PDF из R2; studentId — для ученика: чужое задание → 404. */
export const fileResponse = async (db: Db, files: R2Bucket, id: string, studentId?: string) => {
  const row = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.id, id), studentId ? eq(assignments.studentId, studentId) : undefined))
    .get();
  const object = row && (await files.get(fileKey(row)));
  if (!row || !object) throw notFound('Файл не найден');
  return new Response(object.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(object.size),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      'x-content-type-options': 'nosniff',
    },
  });
};

/**
 * Cron: удалить из R2 файлы без строки в БД (занятие или ученик удалены, загрузка оборвалась).
 * ponytail: полный проход по бакету и всем id раз в сутки; хватит на тысячи файлов, дальше — чистить при удалении.
 */
export const sweepOrphanFiles = async (db: Db, files: R2Bucket, now: number) => {
  const known = new Set(
    (await db.select({ id: assignments.id, studentId: assignments.studentId }).from(assignments)).map(fileKey),
  );
  const orphans: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await files.list({ prefix: FILES_PREFIX, cursor });
    for (const o of page.objects) {
      if (!known.has(o.key) && o.uploaded.getTime() < now - ORPHAN_GRACE_MS) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // R2 удаляет до 1000 ключей за вызов.
  for (let i = 0; i < orphans.length; i += 1000) await files.delete(orphans.slice(i, i + 1000));
  return orphans.length;
};
