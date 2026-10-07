import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Db } from '../../db';
import { ApiError, notFound } from '../../lib/errors';
import { lessons } from '../schedule/schema';
import { students } from '../students/schema';
import { type Assignment, assignments, fileKey, FILES_PREFIX } from './schema';

export const MAX_FILE_MB = 20;
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
});

const assertPdf = async (file: File) => {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new ApiError(413, 'file_too_large', `Файл больше ${MAX_FILE_MB} МБ`);
  }
  // Проверяем сигнатуру, а не только расширение: файл потом отдаётся ученику как application/pdf.
  if ((await file.slice(0, 5).text()) !== '%PDF-') throw new ApiError(400, 'not_pdf', 'Нужен PDF-файл');
};

const upload = async (
  db: Db,
  files: R2Bucket,
  input: Pick<Assignment, 'studentId' | 'lessonId' | 'kind'>,
  file: File,
) => {
  await assertPdf(file);
  const row = { ...input, id: nanoid(), fileName: file.name || 'file.pdf', size: file.size };
  await files.put(fileKey(row), file.stream(), { httpMetadata: { contentType: 'application/pdf' } });
  return publicAssignment(await db.insert(assignments).values(row).returning().get());
};

export const uploadToLesson = async (
  db: Db,
  files: R2Bucket,
  lessonId: string,
  kind: Assignment['kind'],
  file: File,
) => {
  const lesson = await db.select({ studentId: lessons.studentId }).from(lessons).where(eq(lessons.id, lessonId)).get();
  if (!lesson) throw notFound('Занятие не найдено');
  return upload(db, files, { studentId: lesson.studentId, lessonId, kind }, file);
};

export const uploadMock = async (db: Db, files: R2Bucket, studentId: string, file: File) => {
  const student = await db.select({ id: students.id }).from(students).where(eq(students.id, studentId)).get();
  if (!student) throw notFound('Ученик не найден');
  return upload(db, files, { studentId, lessonId: null, kind: 'mock' }, file);
};

/** Пробники ученика по порядку загрузки; number — «Пробник N». */
export const listMocks = async (db: Db, studentId: string) => {
  const rows = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.studentId, studentId), eq(assignments.kind, 'mock')))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  return rows.map((a, i) => ({ ...publicAssignment(a), number: i + 1 }));
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
