import { TZDate } from '@date-fns/tz';
import { desc } from 'drizzle-orm';
import type * as v from 'valibot';

import type { Db } from '../../../db';
import { lessonSeries, type Series } from '../../schedule/schema';
import type { getLesson } from '../../schedule/service';

type Annotations = { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };

export type Tool<S extends v.GenericSchema = v.GenericSchema> = {
  name: string;
  title: string;
  description: string;
  /** Схема аргументов: валидирует вызов и превращается в inputSchema для tools/list. */
  input: S;
  annotations: Annotations;
  /** Ошибки бросает ApiError — клиенту уходят как isError с текстом. */
  run: (db: Db, input: v.InferOutput<S>) => Promise<unknown>;
};

/** Тип аргументов run выводится из схемы; в общем списке инструменты хранятся без него. */
export const defineTool = <S extends v.GenericSchema>(tool: Tool<S>) => tool as unknown as Tool;

export const READ_ONLY: Annotations = { readOnlyHint: true, openWorldHint: false };

export const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/**
 * Пояс репетитора — из последнего созданного правила (его ставит браузер репетитора); без правил — UTC.
 * ponytail: один репетитор — один пояс; если начнёт ездить по поясам — настройка в профиле.
 */
export const tutorTimezone = async (db: Db) =>
  (await db.select({ tz: lessonSeries.timezone }).from(lessonSeries).orderBy(desc(lessonSeries.createdAt)).get())?.tz ??
  'UTC';

/** Момент в поясе репетитора: `2026-10-09T18:00:00.000+03:00`. */
export const local = (at: Date | number, tz: string) => new TZDate(+at, tz).toISOString();

const weekday = (at: Date, tz: string) => WEEKDAYS[(new TZDate(+at, tz).getDay() + 6) % 7];

export const lessonView = (l: Awaited<ReturnType<typeof getLesson>>, tz: string) => ({
  id: l.id,
  startsAt: local(l.startsAt, tz),
  weekday: weekday(l.startsAt, tz),
  durationMin: l.durationMin,
  status: l.status,
  regular: l.seriesId !== null,
  // Перенесённое занятие попадает и в день, откуда его перенесли.
  movedFrom: l.isModified && l.originalStartsAt ? local(l.originalStartsAt, tz) : null,
  student: l.student,
  assignments: l.assignments.map(a => ({ kind: a.kind, fileName: a.fileName })),
});

export const seriesView = (s: Series) => ({
  id: s.id,
  studentId: s.studentId,
  weekday: WEEKDAYS[s.weekday - 1],
  startTime: s.startTime,
  durationMin: s.durationMin,
  timezone: s.timezone,
  startsOn: s.startsOn,
  endsOn: s.endsOn,
});
