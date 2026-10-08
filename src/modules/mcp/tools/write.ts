import { eq } from 'drizzle-orm';
import * as v from 'valibot';

import type { Db } from '../../../db';
import { ApiError } from '../../../lib/errors';
import { isoDate } from '../../../lib/validation';
import { durationMin, rule } from '../../schedule/routes';
import { lessonSeries } from '../../schedule/schema';
import {
  changeSeries,
  createLesson,
  createSeries,
  deleteLesson,
  endSeries,
  getLesson,
  setLessonStatus,
  updateLesson,
} from '../../schedule/service';
import { addDays, toUtc } from '../../schedule/time';
import { studentFields } from '../../students/routes';
import { createStudent, updateStudent } from '../../students/service';
import { VIEWS } from '../views';
import { getStudent } from './read';
import { defineTool, lessonView, local, seriesView, tutorTimezone } from './shared';

/**
 * Изменение данных через Claude — те же сервисы, что у кабинета. Время на входе — в поясе репетитора.
 * Удаления учеников и операций с файлами здесь нет намеренно: только из кабинета.
 */

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const describe = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const studentId = describe(v.string(), 'id ученика из list_students');
const lessonId = describe(v.string(), 'id занятия из get_lessons');
const seriesId = describe(v.string(), 'id правила из get_series');
const date = describe(isoDate, 'YYYY-MM-DD в поясе репетитора');
const time = describe(rule.startTime, 'HH:MM в поясе репетитора');
const timezone = describe(rule.timezone, 'IANA-пояс; по умолчанию — пояс репетитора');
const seriesRule = {
  weekday: describe(rule.weekday, '1–7, 1 — понедельник'),
  startTime: time,
  durationMin: describe(durationMin, 'длительность в минутах'),
  timezone: v.optional(timezone),
};

const lessonResult = async (db: Db, id: string) => lessonView(await getLesson(db, id), await tutorTimezone(db));

const lessonStatusTool = (name: string, title: string, status: 'cancelled' | 'scheduled', description: string) =>
  defineTool({
    name,
    title,
    description,
    input: v.object({ lessonId }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (db, input) => {
      await setLessonStatus(db, input.lessonId, status);
      return lessonResult(db, input.lessonId);
    },
  });

export const writeTools = [
  defineTool({
    name: 'create_student',
    title: 'Новый ученик',
    description:
      'Создать ученика; в ответе — его карточка. exam: oge | ege_base | ege_profile; grade 1–11; null — не указано. ' +
      'Несколько учеников — по вызову на каждого.',
    input: v.object(studentFields),
    annotations: WRITE,
    view: VIEWS.student.uri,
    run: async (db, input) => getStudent(db, (await createStudent(db, input)).id),
  }),
  defineTool({
    name: 'update_student',
    title: 'Изменить ученика',
    description:
      'Изменить имя, класс, экзамен, контакт или заметки ученика; в ответе — обновлённая карточка. ' +
      'Передавай только меняющиеся поля.',
    input: v.object({ studentId, ...v.partial(v.object(studentFields)).entries }),
    annotations: { ...WRITE, idempotentHint: true },
    view: VIEWS.student.uri,
    run: async (db, { studentId: id, ...patch }) => {
      await updateStudent(db, id, patch);
      return getStudent(db, id);
    },
  }),
  defineTool({
    name: 'create_lesson',
    title: 'Разовое занятие',
    description: 'Добавить разовое занятие (вне регулярного расписания).',
    input: v.object({ studentId, date, time, durationMin: seriesRule.durationMin }),
    annotations: WRITE,
    run: async (db, input) => {
      const tz = await tutorTimezone(db);
      const startsAt = new Date(toUtc(input.date, input.time, tz));
      const lesson = await createLesson(db, { studentId: input.studentId, startsAt, durationMin: input.durationMin });
      return lessonResult(db, lesson.id);
    },
  }),
  defineTool({
    name: 'move_lesson',
    title: 'Перенос занятия',
    description:
      'Перенести одно занятие или поменять его длительность. Не указанные date/time остаются прежними. ' +
      'Регулярное правило и остальные занятия не меняются.',
    input: v.object({
      lessonId,
      date: v.optional(date),
      time: v.optional(time),
      durationMin: v.optional(seriesRule.durationMin),
    }),
    annotations: WRITE,
    run: async (db, input) => {
      if (!input.date && !input.time && input.durationMin === undefined) {
        throw new ApiError(400, 'validation_error', 'Укажите date, time или durationMin');
      }
      const tz = await tutorTimezone(db);
      const current = local((await getLesson(db, input.lessonId)).startsAt, tz);
      const startsAt =
        input.date || input.time
          ? new Date(toUtc(input.date ?? current.slice(0, 10), input.time ?? current.slice(11, 16), tz))
          : undefined;
      await updateLesson(db, input.lessonId, { startsAt, durationMin: input.durationMin });
      return lessonResult(db, input.lessonId);
    },
  }),
  lessonStatusTool(
    'cancel_lesson',
    'Отменить занятие',
    'cancelled',
    'Отменить занятие (останется в расписании со статусом cancelled, можно вернуть restore_lesson). ' +
      'Для регулярных занятий — единственный способ убрать одно занятие.',
  ),
  lessonStatusTool('restore_lesson', 'Вернуть занятие', 'scheduled', 'Вернуть отменённое занятие.'),
  defineTool({
    name: 'delete_lesson',
    title: 'Удалить разовое занятие',
    description: 'Удалить разовое занятие насовсем вместе с его файлами. Регулярные удалить нельзя — только отменить.',
    input: v.object({ lessonId }),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (db, input) => {
      await deleteLesson(db, input.lessonId);
      return { deleted: input.lessonId };
    },
  }),
  defineTool({
    name: 'create_series',
    title: 'Новое регулярное расписание',
    description: 'Регулярное занятие раз в неделю с даты startsOn; занятия создаются на 8 недель вперёд.',
    input: v.object({ studentId, startsOn: date, ...seriesRule }),
    annotations: WRITE,
    run: async (db, { timezone: tz, ...input }) =>
      seriesView((await createSeries(db, { ...input, timezone: tz ?? (await tutorTimezone(db)) }, Date.now()))!),
  }),
  defineTool({
    name: 'change_series',
    title: 'Изменить регулярное расписание',
    description:
      'Новые день, время или длительность с даты fromDate (старое правило заканчивается накануне). ' +
      'Передавай все поля правила, даже неизменные. Перенесённые вручную занятия не трогаются.',
    input: v.object({ seriesId, fromDate: date, ...seriesRule }),
    annotations: WRITE,
    run: async (db, { seriesId: id, timezone: tz, ...input }) => {
      const old = await db
        .select({ tz: lessonSeries.timezone })
        .from(lessonSeries)
        .where(eq(lessonSeries.id, id))
        .get();
      const timezone = tz ?? old?.tz ?? (await tutorTimezone(db));
      return seriesView((await changeSeries(db, id, { ...input, timezone }, Date.now()))!);
    },
  }),
  defineTool({
    name: 'end_series',
    title: 'Завершить регулярное расписание',
    description:
      'Закончить регулярные занятия с даты fromDate: будущие занятия правила удаляются, перенесённые вручную остаются.',
    input: v.object({ seriesId, fromDate: date }),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (db, input) => {
      await endSeries(db, input.seriesId, input.fromDate, Date.now());
      return { ended: input.seriesId, lastDay: addDays(input.fromDate, -1) };
    },
  }),
];
