import { TZDate } from '@date-fns/tz';
import { env } from 'cloudflare:workers';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { getDb } from '../../db';
import { students } from '../students/schema';
import { lessons, lessonSeries } from './schema';
import {
  archiveStudent,
  changeSeries,
  createLesson,
  createSeries,
  endSeries,
  generateAll,
  generateForSeries,
  horizon,
  updateLesson,
} from './service';

const db = getDb(env);
const ROME = 'Europe/Rome';
// Понедельник, 2 ноября 2026, 09:00 по Риму.
const NOW = Date.parse('2026-11-02T08:00:00Z');

const newStudent = () => db.insert(students).values({ name: 'Тест' }).returning().get();

const wednesdays = async (studentId: string, now = NOW) => {
  const series = await createSeries(
    db,
    { studentId, weekday: 3, startTime: '18:00', durationMin: 60, timezone: ROME, startsOn: '2026-11-02' },
    now,
  );
  if (!series) throw new Error('series not created');
  return series;
};

const seriesLessons = (seriesId: string) =>
  db.select().from(lessons).where(eq(lessons.seriesId, seriesId)).orderBy(asc(lessons.startsAt));

const studentLessons = (studentId: string) =>
  db.select().from(lessons).where(eq(lessons.studentId, studentId)).orderBy(asc(lessons.startsAt));

const local = (d: Date) => {
  const t = new TZDate(d.getTime(), ROME);
  return { weekday: t.getDay() || 7, time: `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}` };
};

describe('генерация', () => {
  it('материализует регулярные занятия на 8 недель вперёд', async () => {
    const { id: studentId } = await newStudent();
    const series = await wednesdays(studentId);
    const rows = await seriesLessons(series.id);

    expect(rows).toHaveLength(8);
    expect(rows[0]?.startsAt.toISOString()).toBe('2026-11-04T17:00:00.000Z');
    for (const l of rows) {
      expect(local(l.startsAt)).toEqual({ weekday: 3, time: '18:00' });
      expect(l.originalStartsAt).toEqual(l.startsAt);
      expect(l.isModified).toBe(false);
    }
  });

  it('переход на зимнее время 25.10.2026: 18:00 по Риму остаётся 18:00, UTC сдвигается', async () => {
    const { id: studentId } = await newStudent();
    const now = Date.parse('2026-10-12T06:00:00Z');
    const series = await createSeries(
      db,
      { studentId, weekday: 1, startTime: '18:00', durationMin: 60, timezone: ROME, startsOn: '2026-10-12' },
      now,
    );
    const rows = await seriesLessons(series?.id ?? '');

    expect(rows.slice(0, 3).map(l => l.startsAt.toISOString())).toEqual([
      '2026-10-12T16:00:00.000Z', // CEST, UTC+2
      '2026-10-19T16:00:00.000Z',
      '2026-10-26T17:00:00.000Z', // CET, UTC+1
    ]);
    for (const l of rows) expect(local(l.startsAt).time).toBe('18:00');
  });

  it('идемпотентна', async () => {
    const { id: studentId } = await newStudent();
    const series = await wednesdays(studentId);
    const before = await seriesLessons(series.id);

    await generateForSeries(db, series.id, horizon(NOW, ROME), NOW);
    await generateAll(db, NOW);

    expect(await seriesLessons(series.id)).toEqual(before);
  });
});

describe('изменения', () => {
  it('перенос одного занятия не влияет на остальные', async () => {
    const { id: studentId } = await newStudent();
    const series = await wednesdays(studentId);
    const before = await seriesLessons(series.id);
    const target = before[2];
    if (!target) throw new Error('no lesson');

    const movedTo = new Date('2026-11-19T15:00:00Z');
    await updateLesson(db, target.id, { startsAt: movedTo });
    await generateForSeries(db, series.id, horizon(NOW, ROME), NOW);

    const after = await seriesLessons(series.id);
    expect(after).toHaveLength(8);
    const moved = after.find(l => l.id === target.id);
    expect(moved).toMatchObject({ startsAt: movedTo, originalStartsAt: target.originalStartsAt, isModified: true });
    const others = (rows: typeof before) =>
      rows.filter(l => l.id !== target.id).map(l => ({ id: l.id, startsAt: l.startsAt, isModified: l.isModified }));
    expect(others(after)).toEqual(others(before));
  });

  it('изменение правила с даты сохраняет id занятий и не трогает перенесённые', async () => {
    const { id: studentId } = await newStudent();
    const old = await wednesdays(studentId);
    const before = await seriesLessons(old.id);
    // Ср 04.11, 11.11 — до даты изменения; 25.11 переносим вручную.
    const modified = before[3];
    if (!modified) throw new Error('no lesson');
    await updateLesson(db, modified.id, { durationMin: 90 });

    const next = await changeSeries(
      db,
      old.id,
      { fromDate: '2026-11-16', weekday: 5, startTime: '17:00', durationMin: 45, timezone: ROME },
      NOW,
    );
    if (!next) throw new Error('series not created');

    const oldSeries = await db.select().from(lessonSeries).where(eq(lessonSeries.id, old.id)).get();
    expect(oldSeries?.endsOn).toBe('2026-11-15');
    expect(next.startsOn).toBe('2026-11-16');

    const oldRows = await seriesLessons(old.id);
    expect(oldRows.map(l => l.id)).toEqual([before[0]?.id, before[1]?.id, modified.id]);
    expect(oldRows[2]).toMatchObject({ startsAt: modified.startsAt, durationMin: 90, isModified: true });

    const newRows = await seriesLessons(next.id);
    // Пятницы 20.11–25.12 до горизонта 28.12.
    expect(newRows).toHaveLength(6);
    for (const l of newRows) {
      expect(local(l.startsAt)).toEqual({ weekday: 5, time: '17:00' });
      expect(l).toMatchObject({ durationMin: 45, isModified: false });
    }
    const reusable = before.filter(l => l.startsAt >= new Date('2026-11-16') && l.id !== modified.id).map(l => l.id);
    expect(reusable).toHaveLength(5);
    expect(newRows.slice(0, 5).map(l => l.id)).toEqual(reusable);
  });

  it('завершение правила удаляет будущие немодифицированные занятия', async () => {
    const { id: studentId } = await newStudent();
    const series = await wednesdays(studentId);
    const before = await seriesLessons(series.id);
    const modified = before[4];
    if (!modified) throw new Error('no lesson');
    await updateLesson(db, modified.id, { durationMin: 30 });

    await endSeries(db, series.id, '2026-11-16', NOW);
    await generateAll(db, NOW);

    const after = await seriesLessons(series.id);
    expect(after.map(l => l.id)).toEqual([before[0]?.id, before[1]?.id, modified.id]);
    const ended = await db.select().from(lessonSeries).where(eq(lessonSeries.id, series.id)).get();
    expect(ended?.endsOn).toBe('2026-11-15');
  });

  it('архивация ученика завершает правила и чистит будущие занятия', async () => {
    const { id: studentId } = await newStudent();
    const series = await wednesdays(studentId);
    await createLesson(db, { studentId, startsAt: new Date('2026-11-10T10:00:00Z'), durationMin: 60 });

    // Через неделю: занятие 04.11 уже прошло и должно остаться.
    const later = Date.parse('2026-11-09T08:00:00Z');
    const archived = await archiveStudent(db, studentId, later);
    await generateAll(db, later);

    expect(archived?.archivedAt).toEqual(new Date(later));
    const ended = await db.select().from(lessonSeries).where(eq(lessonSeries.id, series.id)).get();
    expect(ended?.endsOn).toBe('2026-11-08');
    const left = await studentLessons(studentId);
    expect(left.map(l => l.startsAt.toISOString())).toEqual(['2026-11-04T17:00:00.000Z']);
  });
});
