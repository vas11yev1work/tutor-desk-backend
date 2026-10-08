import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import * as v from 'valibot';

import type { Db } from '../../../db';
import { ApiError, notFound } from '../../../lib/errors';
import { isoDate } from '../../../lib/validation';
import { assignments } from '../../assignments/schema';
import { EXAM_MAX_SCORES, sum } from '../../assignments/scores';
import { listMocks } from '../../assignments/service';
import { listActiveSeries, listLessons } from '../../schedule/service';
import { addDays, localDate, toUtc } from '../../schedule/time';
import { students } from '../../students/schema';
import { EXAM_TOPICS } from '../topics';
import { VIEWS } from '../views';
import { defineTool, lessonView, local, READ_ONLY, seriesView, tutorTimezone } from './shared';

const MAX_RANGE_DAYS = 93;

const byStudent = v.object({ studentId: v.optional(v.pipe(v.string(), v.description('id ученика из list_students'))) });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Занятия в [from, to) в поясе репетитора. */
const lessonsBetween = async (db: Db, tz: string, from: number, to: number, studentId?: string) =>
  (await listLessons(db, { from: new Date(from), to: new Date(to), studentId })).map(l => lessonView(l, tz));

/** Карточка ученика: её же возвращают create_student и update_student. */
export const getStudent = async (db: Db, id: string) => {
  const student = await db
    .select({
      id: students.id,
      name: students.name,
      grade: students.grade,
      exam: students.exam,
      contact: students.contact,
      notes: students.notes,
    })
    .from(students)
    .where(eq(students.id, id))
    .get();
  if (!student) throw notFound('Ученик не найден');
  const tz = await tutorTimezone(db);
  const now = Date.now();
  const [upcoming, series, mocks] = await Promise.all([
    lessonsBetween(db, tz, now, now + 14 * DAY_MS, id),
    listActiveSeries(db, id, now),
    listMocks(db, id),
  ]);
  return {
    now: local(now, tz),
    student,
    upcoming: upcoming.filter(l => l.status !== 'cancelled').slice(0, 5),
    series: series.map(s => {
      const { studentId: _, ...rest } = seriesView(s);
      return rest;
    }),
    mocks: {
      max: student.exam ? sum(EXAM_MAX_SCORES[student.exam]) : null,
      items: mocks.map(m => ({ number: m.number, lessonDate: local(m.lessonStartsAt, tz), total: m.total })),
    },
  };
};

const getMocks = async (db: Db, studentId?: string) => {
  const rows = await db
    .select({ id: students.id, name: students.name, exam: students.exam })
    .from(students)
    .where(studentId ? eq(students.id, studentId) : isNotNull(students.exam))
    .orderBy(asc(students.name));
  if (studentId && !rows.length) throw notFound('Ученик не найден');
  const tz = await tutorTimezone(db);
  const exams = [...new Set(rows.flatMap(r => (r.exam ? [r.exam] : [])))];
  return {
    tasks: Object.fromEntries(
      exams.map(e => [e, EXAM_MAX_SCORES[e].map((max, i) => ({ number: i + 1, max, topic: EXAM_TOPICS[e][i] }))]),
    ),
    // ponytail: запрос на ученика; на десятках учеников ок, на сотнях — один запрос с группировкой.
    students: await Promise.all(
      rows.map(async s => ({
        ...s,
        mocks: (await listMocks(db, s.id)).map(m => ({
          number: m.number,
          lessonDate: local(m.lessonStartsAt, tz),
          scores: m.scores,
          total: m.total,
          comment: m.comment,
        })),
      })),
    ),
  };
};

export const readTools = [
  defineTool({
    name: 'list_students',
    title: 'Ученики',
    description:
      'Все ученики: id, имя, класс, экзамен, контакт, заметки репетитора, сколько пробников выдано и проверено.',
    input: v.object({}),
    annotations: READ_ONLY,
    view: VIEWS.students.uri,
    run: db =>
      db
        .select({
          id: students.id,
          name: students.name,
          grade: students.grade,
          exam: students.exam,
          contact: students.contact,
          notes: students.notes,
          mocks: count(assignments.id),
          scoredMocks: count(assignments.scores),
        })
        .from(students)
        .leftJoin(assignments, and(eq(assignments.studentId, students.id), eq(assignments.kind, 'mock')))
        .groupBy(students.id)
        .orderBy(asc(students.name)),
  }),
  defineTool({
    name: 'get_student',
    title: 'Карточка ученика',
    description:
      'Всё про одного ученика: профиль, ближайшие занятия (до 5 за 2 недели), регулярное расписание, итоги пробников. ' +
      'Для «покажи ученика X». Баллы по номерам заданий — в get_mocks.',
    input: v.object({ studentId: v.pipe(v.string(), v.description('id ученика из list_students')) }),
    annotations: READ_ONLY,
    view: VIEWS.student.uri,
    run: (db, { studentId }) => getStudent(db, studentId),
  }),
  defineTool({
    name: 'get_mocks',
    title: 'Пробники',
    description:
      'Пробники с баллами по номерам заданий, плюс максимум и тема каждого номера (tasks). ' +
      'Без studentId — все ученики с выбранным экзаменом (для сравнения по группе).',
    input: byStudent,
    annotations: READ_ONLY,
    run: (db, { studentId }) => getMocks(db, studentId),
  }),
  defineTool({
    name: 'get_lessons',
    title: 'Занятия',
    description:
      'Занятия за период с учеником, статусом (scheduled/cancelled), переносом и файлами (homework — домашка, mock — пробник). ' +
      'По умолчанию — с текущего момента на 7 дней вперёд: подходит для «когда ближайший урок». Можно смотреть и прошлое.',
    input: v.object({
      ...byStudent.entries,
      from: v.optional(
        v.pipe(isoDate, v.description('YYYY-MM-DD включительно, в поясе репетитора; по умолчанию — сейчас')),
      ),
      to: v.optional(v.pipe(isoDate, v.description('YYYY-MM-DD включительно; по умолчанию — через 7 дней'))),
    }),
    annotations: READ_ONLY,
    view: VIEWS.week.uri,
    run: async (db, input) => {
      const tz = await tutorTimezone(db);
      const now = Date.now();
      const from = input.from ? toUtc(input.from, '00:00', tz) : now;
      const to = toUtc(addDays(input.to ?? addDays(localDate(now, tz), 7), 1), '00:00', tz);
      if (from >= to) throw new ApiError(400, 'validation_error', 'from должен быть не позже to');
      if (to - from > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
        throw new ApiError(400, 'validation_error', `Период не больше ${MAX_RANGE_DAYS} дней`);
      }
      return { now: local(now, tz), timezone: tz, lessons: await lessonsBetween(db, tz, from, to, input.studentId) };
    },
  }),
  defineTool({
    name: 'get_today',
    title: 'Сегодня',
    description:
      'Все занятия на сегодня (в поясе репетитора), включая прошедшие и отменённые. Для «что у меня сегодня».',
    input: v.object({}),
    annotations: READ_ONLY,
    view: VIEWS.today.uri,
    run: async db => {
      const tz = await tutorTimezone(db);
      const now = Date.now();
      const today = localDate(now, tz);
      const lessons = await lessonsBetween(db, tz, toUtc(today, '00:00', tz), toUtc(addDays(today, 1), '00:00', tz));
      return { now: local(now, tz), timezone: tz, lessons };
    },
  }),
  defineTool({
    name: 'get_series',
    title: 'Регулярное расписание',
    description:
      'Действующие правила регулярных занятий (id, день недели, время, длительность, с какой и до какой даты). ' +
      'Без studentId — все ученики.',
    input: byStudent,
    annotations: READ_ONLY,
    run: async (db, { studentId }) => {
      const [rows, names] = await Promise.all([
        listActiveSeries(db, studentId, Date.now()),
        db.select({ id: students.id, name: students.name }).from(students),
      ]);
      const nameOf = new Map(names.map(s => [s.id, s.name]));
      return rows.map(s => {
        const { studentId: id, ...rest } = seriesView(s);
        return { ...rest, student: { id, name: nameOf.get(id) } };
      });
    },
  }),
];
