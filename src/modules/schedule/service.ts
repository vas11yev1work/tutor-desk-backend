import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { nanoid } from 'nanoid';

import { type Db, runBatch } from '../../db';
import { ApiError, notFound } from '../../lib/errors';
import { students } from '../students/schema';
import { type Lesson, lessons, lessonSeries, type Series } from './schema';
import { addDays, isoWeekday, localDate, toUtc } from './time';

/** Регулярные занятия материализуются на 8 недель вперёд от сегодня. */
export const HORIZON_DAYS = 8 * 7;

export type Rule = Pick<Series, 'weekday' | 'startTime' | 'durationMin' | 'timezone'>;
type SeriesDraft = Rule & Pick<Series, 'id' | 'studentId' | 'startsOn' | 'endsOn'>;

const min = (a: string, b: string) => (a < b ? a : b);
const max = (a: string, b: string) => (a > b ? a : b);

/** Сегодня + 8 недель (исключительно) в поясе правила. */
export const horizon = (now: number, tz: string) => addDays(localDate(now, tz), HORIZON_DAYS);

/** UTC-моменты занятий правила в датах [max(startsOn, сегодня), until), не раньше now. */
const occurrences = (series: SeriesDraft, until: string, now: number) => {
  const from = max(series.startsOn, localDate(now, series.timezone));
  const end = series.endsOn ? min(until, addDays(series.endsOn, 1)) : until;
  const result: number[] = [];
  for (let d = addDays(from, (series.weekday - isoWeekday(from) + 7) % 7); d < end; d = addDays(d, 7)) {
    const at = toUtc(d, series.startTime, series.timezone);
    if (at >= now) result.push(at);
  }
  return result;
};

const insertLesson = (db: Db, series: SeriesDraft, at: number) =>
  db
    .insert(lessons)
    .values({
      studentId: series.studentId,
      seriesId: series.id,
      startsAt: new Date(at),
      originalStartsAt: new Date(at),
      durationMin: series.durationMin,
    })
    // unique (series_id, original_starts_at) — повторная генерация ничего не дублирует.
    .onConflictDoNothing();

const generateQueries = (db: Db, series: SeriesDraft, until: string, now: number) =>
  occurrences(series, until, now).map(at => insertLesson(db, series, at));

/** Начало дня `date` в поясе `tz`, но не раньше now: прошедшие занятия не трогаем. */
const cutoff = (date: string, tz: string, now: number) => new Date(Math.max(toUtc(date, '00:00', tz), now));

const assertNotPast = (date: string, tz: string, now: number) => {
  if (date < localDate(now, tz)) throw new ApiError(400, 'date_in_past', 'Дата не может быть в прошлом');
};

const assertStudent = async (db: Db, studentId: string) => {
  const student = await db.select({ id: students.id }).from(students).where(eq(students.id, studentId)).get();
  if (!student) throw notFound('Ученик не найден');
};

const getActiveSeries = async (db: Db, seriesId: string, fromDate: string, now: number) => {
  const series = await db.select().from(lessonSeries).where(eq(lessonSeries.id, seriesId)).get();
  if (!series) throw notFound('Правило не найдено');
  if (series.endsOn && series.endsOn < fromDate) throw new ApiError(409, 'series_ended', 'Правило уже завершено');
  assertNotPast(fromDate, series.timezone, now);
  return series;
};

/** Cron: догенерировать занятия всех активных правил до горизонта. */
export const generateAll = async (db: Db, now: number) => {
  // Пояса правил отличаются от UTC максимум на сутки; точную границу проверяет occurrences().
  const active = await db
    .select()
    .from(lessonSeries)
    .where(or(isNull(lessonSeries.endsOn), gte(lessonSeries.endsOn, addDays(localDate(now, 'UTC'), -1))));
  for (const series of active) {
    await runBatch(db, generateQueries(db, series, horizon(now, series.timezone), now));
  }
};

export const createSeries = async (db: Db, input: Rule & Pick<Series, 'studentId' | 'startsOn'>, now: number) => {
  await assertStudent(db, input.studentId);
  const series: SeriesDraft = { ...input, id: nanoid(), endsOn: null };
  await runBatch(db, [
    db.insert(lessonSeries).values(series),
    ...generateQueries(db, series, horizon(now, series.timezone), now),
  ]);
  return db.select().from(lessonSeries).where(eq(lessonSeries.id, series.id)).get();
};

/**
 * Изменение правила с даты D: старое заканчивается D-1, новое начинается с D.
 * Будущие немодифицированные занятия старого правила переезжают на новое по порядку недель (id сохраняются),
 * лишние удаляются, недостающие генерируются. Перенесённые вручную (is_modified) не трогаем.
 */
export const changeSeries = async (db: Db, seriesId: string, input: Rule & { fromDate: string }, now: number) => {
  const { fromDate, ...rule } = input;
  const old = await getActiveSeries(db, seriesId, fromDate, now);

  const next: SeriesDraft = { ...rule, id: nanoid(), studentId: old.studentId, startsOn: fromDate, endsOn: old.endsOn };
  const reusable = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(
      and(
        eq(lessons.seriesId, old.id),
        gte(lessons.startsAt, cutoff(fromDate, old.timezone, now)),
        eq(lessons.isModified, false),
        eq(lessons.status, 'scheduled'),
      ),
    )
    .orderBy(asc(lessons.startsAt));
  const times = occurrences(next, horizon(now, next.timezone), now);

  const lessonQueries: BatchItem<'sqlite'>[] = times.map((at, i) => {
    const lesson = reusable[i];
    if (!lesson) return insertLesson(db, next, at);
    return db
      .update(lessons)
      .set({ seriesId: next.id, startsAt: new Date(at), originalStartsAt: new Date(at), durationMin: next.durationMin })
      .where(eq(lessons.id, lesson.id));
  });
  const extra = reusable.slice(times.length).map(l => l.id);
  if (extra.length) lessonQueries.push(db.delete(lessons).where(inArray(lessons.id, extra)));

  await runBatch(db, [
    db
      .update(lessonSeries)
      .set({ endsOn: addDays(fromDate, -1) })
      .where(eq(lessonSeries.id, old.id)),
    db.insert(lessonSeries).values(next),
    ...lessonQueries,
  ]);
  return db.select().from(lessonSeries).where(eq(lessonSeries.id, next.id)).get();
};

const endSeriesQueries = (db: Db, series: Series, fromDate: string, now: number) => [
  db
    .update(lessonSeries)
    .set({ endsOn: addDays(fromDate, -1) })
    .where(eq(lessonSeries.id, series.id)),
  db
    .delete(lessons)
    .where(
      and(
        eq(lessons.seriesId, series.id),
        gte(lessons.startsAt, cutoff(fromDate, series.timezone, now)),
        eq(lessons.isModified, false),
      ),
    ),
];

/** Завершение правила с даты D: ends_on = D-1, будущие немодифицированные занятия удаляются. */
export const endSeries = async (db: Db, seriesId: string, fromDate: string, now: number) => {
  const series = await getActiveSeries(db, seriesId, fromDate, now);
  await runBatch(db, endSeriesQueries(db, series, fromDate, now));
};

/** Удаление ученика навсегда: вместе со всеми правилами и занятиями, включая прошедшие. */
export const deleteStudent = async (db: Db, studentId: string) => {
  await assertStudent(db, studentId);
  await db.batch([
    db.delete(lessons).where(eq(lessons.studentId, studentId)),
    db.delete(lessonSeries).where(eq(lessonSeries.studentId, studentId)),
    db.delete(students).where(eq(students.id, studentId)),
  ]);
};

/** Правила ученика, которые ещё действуют (ends_on не раньше сегодня), включая начинающиеся в будущем. */
export const listActiveSeries = async (db: Db, studentId: string, now: number) => {
  const rows = await db
    .select()
    .from(lessonSeries)
    .where(eq(lessonSeries.studentId, studentId))
    .orderBy(asc(lessonSeries.weekday), asc(lessonSeries.startTime), asc(lessonSeries.startsOn));
  return rows.filter(s => !s.endsOn || s.endsOn >= localDate(now, s.timezone));
};

/** Занятия, у которых в диапазон попадает startsAt или originalStartsAt: перенесённое видно в обоих днях. */
export const listLessons = (db: Db, range: { from: Date; to: Date; studentId?: string }) =>
  db
    .select({
      id: lessons.id,
      seriesId: lessons.seriesId,
      startsAt: lessons.startsAt,
      durationMin: lessons.durationMin,
      status: lessons.status,
      originalStartsAt: lessons.originalStartsAt,
      isModified: lessons.isModified,
      student: { id: students.id, name: students.name, grade: students.grade, exam: students.exam },
    })
    .from(lessons)
    .innerJoin(students, eq(students.id, lessons.studentId))
    .where(
      and(
        or(
          and(gte(lessons.startsAt, range.from), lt(lessons.startsAt, range.to)),
          and(gte(lessons.originalStartsAt, range.from), lt(lessons.originalStartsAt, range.to)),
        ),
        range.studentId ? eq(lessons.studentId, range.studentId) : undefined,
      ),
    )
    .orderBy(asc(lessons.startsAt));

export const createLesson = async (db: Db, input: Pick<Lesson, 'studentId' | 'startsAt' | 'durationMin'>) => {
  await assertStudent(db, input.studentId);
  return db.insert(lessons).values(input).returning().get();
};

/** Перенос одного занятия: помечается is_modified, правило и остальные занятия не трогаются. */
export const updateLesson = async (db: Db, id: string, patch: Partial<Pick<Lesson, 'startsAt' | 'durationMin'>>) => {
  const [lesson] = await db
    .update(lessons)
    .set({ ...patch, isModified: true })
    .where(eq(lessons.id, id))
    .returning();
  if (!lesson) throw notFound('Занятие не найдено');
  return lesson;
};

export const setLessonStatus = async (db: Db, id: string, status: Lesson['status']) => {
  const [lesson] = await db.update(lessons).set({ status }).where(eq(lessons.id, id)).returning();
  if (!lesson) throw notFound('Занятие не найдено');
  return lesson;
};
