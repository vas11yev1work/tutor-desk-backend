import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Db } from '../../db';
import { ApiError, notFound } from '../../lib/errors';
import { type Student, students } from './schema';

export const MAX_COVER_MB = 5;

// Свой префикс: sweepOrphanFiles чистит только students/ и обложки не трогает.
const coverKey = (studentId: string, coverId: string) => `covers/${studentId}/${coverId}`;

/** Тип картинки по сигнатуре, а не по расширению: файл потом отдаётся с этим content-type. */
const imageType = async (file: File) => {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const findCover = async (db: Db, id: string) => {
  const row = await db.select({ coverId: students.coverId }).from(students).where(eq(students.id, id)).get();
  if (!row) throw notFound('Ученик не найден');
  return row.coverId;
};

/** Новая обложка получает новый coverId: URL меняется, старый кэш браузера не мешает. */
export const setCover = async (db: Db, files: R2Bucket, id: string, file: File | null) => {
  const oldCoverId = await findCover(db, id);
  let coverId: string | null = null;
  if (file) {
    if (file.size > MAX_COVER_MB * 1024 * 1024) {
      throw new ApiError(413, 'file_too_large', `Файл больше ${MAX_COVER_MB} МБ`);
    }
    const contentType = await imageType(file);
    if (!contentType) throw new ApiError(400, 'not_image', 'Нужна картинка JPEG, PNG или WebP');
    coverId = nanoid();
    await files.put(coverKey(id, coverId), file.stream(), { httpMetadata: { contentType } });
  }
  const [student] = await db.update(students).set({ coverId }).where(eq(students.id, id)).returning();
  if (!student) throw notFound('Ученик не найден');
  if (oldCoverId) await files.delete(coverKey(id, oldCoverId));
  return student;
};

export const deleteCoverFile = (files: R2Bucket, student: Pick<Student, 'id' | 'coverId'>) =>
  student.coverId ? files.delete(coverKey(student.id, student.coverId)) : Promise.resolve();

export const coverResponse = async (files: R2Bucket, student: Pick<Student, 'id' | 'coverId'>) => {
  const object = student.coverId && (await files.get(coverKey(student.id, student.coverId)));
  if (!object) throw notFound('Обложки нет');
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(object.size),
      // URL меняется вместе с coverId (?v=coverId), поэтому кэшировать можно надолго.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
};
