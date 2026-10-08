import { TZDate } from '@date-fns/tz';
import { and, asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';

import { type Db, getDb } from '../../db';
import { isoDate } from '../../lib/validation';
import { assignments } from '../assignments/schema';
import { EXAM_MAX_SCORES } from '../assignments/scores';
import { listMocks } from '../assignments/service';
import { lessonSeries } from '../schedule/schema';
import { listActiveSeries, listLessons } from '../schedule/service';
import { addDays, localDate, toUtc } from '../schedule/time';
import { students } from '../students/schema';
import { readToken, resourceMetadataUrl } from './oauth';
import { EXAM_TOPICS } from './topics';

/**
 * MCP-сервер (Streamable HTTP, без сессий и SSE): JSON-RPC в POST /api/mcp, ответ — обычный JSON.
 * Только чтение: ученики, расписание и баллы пробников для Claude.
 */

const SERVER_INFO = { name: 'tutor-desk', title: 'Кабинет репетитора', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const INSTRUCTIONS = `Кабинет репетитора по математике: ученики готовятся к ОГЭ, ЕГЭ базе или ЕГЭ профилю.
Пробник — полный вариант экзамена; scores — первичные баллы по номерам заданий (scores[0] — задание 1), null — пробник ещё не проверен.
Максимум и тема каждого номера — в tasks из get_mocks. comment — заметка репетитора к пробнику.
Время везде в поясе репетитора (timezone в ответах), с offset; now в get_lessons — текущий момент.
Регулярные занятия создаются на 8 недель вперёд по правилам из get_series; дальше — только правила.`;

const readOnly = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'list_students',
    title: 'Ученики',
    description: 'Все ученики: id, имя, класс, экзамен, заметки репетитора, сколько пробников выдано и проверено.',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'get_mocks',
    title: 'Пробники',
    description:
      'Пробники с баллами по номерам заданий, плюс максимум и тема каждого номера (tasks). ' +
      'Без studentId — все ученики с выбранным экзаменом (для сравнения по группе).',
    inputSchema: {
      type: 'object',
      properties: { studentId: { type: 'string', description: 'id ученика из list_students' } },
    },
    annotations: readOnly,
  },
  {
    name: 'get_lessons',
    title: 'Занятия',
    description:
      'Занятия за период с учеником, статусом (scheduled/cancelled), переносом и файлами (homework — домашка, mock — пробник). ' +
      'По умолчанию — с текущего момента на 7 дней вперёд: подходит для «когда ближайший урок». Можно смотреть и прошлое.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD включительно, в поясе репетитора; по умолчанию — сейчас' },
        to: { type: 'string', description: 'YYYY-MM-DD включительно; по умолчанию — через 7 дней' },
        studentId: { type: 'string', description: 'id ученика из list_students' },
      },
    },
    annotations: readOnly,
  },
  {
    name: 'get_series',
    title: 'Регулярное расписание',
    description: 'Действующие правила регулярных занятий (день недели, время, длительность, с какой и до какой даты).',
    inputSchema: {
      type: 'object',
      properties: { studentId: { type: 'string', description: 'id ученика; без него — все ученики' } },
    },
    annotations: readOnly,
  },
];

const MAX_RANGE_DAYS = 93;
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const listStudents = (db: Db) =>
  db
    .select({
      id: students.id,
      name: students.name,
      grade: students.grade,
      exam: students.exam,
      notes: students.notes,
      mocks: count(assignments.id),
      scoredMocks: count(assignments.scores),
    })
    .from(students)
    .leftJoin(assignments, and(eq(assignments.studentId, students.id), eq(assignments.kind, 'mock')))
    .groupBy(students.id)
    .orderBy(asc(students.name));

/**
 * Пояс репетитора — из последнего созданного правила (его ставит браузер репетитора); без правил — UTC.
 * ponytail: один репетитор — один пояс; если начнёт ездить по поясам — настройка в профиле.
 */
const tutorTimezone = async (db: Db) =>
  (await db.select({ tz: lessonSeries.timezone }).from(lessonSeries).orderBy(desc(lessonSeries.createdAt)).get())?.tz ??
  'UTC';

/** Момент в поясе репетитора: `2026-10-09T18:00:00.000+03:00`. */
const local = (at: Date | number, tz: string) => new TZDate(+at, tz).toISOString();

const weekday = (at: Date, tz: string) => WEEKDAYS[(new TZDate(+at, tz).getDay() + 6) % 7];

const getLessons = async (db: Db, tz: string, input: { from?: string; to?: string; studentId?: string }) => {
  const now = Date.now();
  const from = input.from ? toUtc(input.from, '00:00', tz) : now;
  const to = toUtc(addDays(input.to ?? addDays(localDate(now, tz), 7), 1), '00:00', tz);
  if (from >= to) return 'from должен быть не позже to';
  if (to - from > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) return `Период не больше ${MAX_RANGE_DAYS} дней`;
  const rows = await listLessons(db, { from: new Date(from), to: new Date(to), studentId: input.studentId });
  return {
    now: local(now, tz),
    timezone: tz,
    lessons: rows.map(l => ({
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
    })),
  };
};

const getSeries = async (db: Db, studentId?: string) => {
  const [rows, names] = await Promise.all([
    listActiveSeries(db, studentId, Date.now()),
    db.select({ id: students.id, name: students.name }).from(students),
  ]);
  const nameOf = new Map(names.map(s => [s.id, s.name]));
  return rows.map(s => ({
    student: { id: s.studentId, name: nameOf.get(s.studentId) },
    weekday: WEEKDAYS[s.weekday - 1],
    startTime: s.startTime,
    durationMin: s.durationMin,
    timezone: s.timezone,
    startsOn: s.startsOn,
    endsOn: s.endsOn,
  }));
};

const getMocks = async (db: Db, tz: string, studentId?: string) => {
  const rows = await db
    .select({ id: students.id, name: students.name, exam: students.exam })
    .from(students)
    .where(studentId ? eq(students.id, studentId) : isNotNull(students.exam))
    .orderBy(asc(students.name));
  if (studentId && !rows.length) return null;
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

const text = (data: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
  ...(isError ? { isError } : {}),
});

const byStudent = v.object({ studentId: v.optional(v.string()) });
const lessonsInput = v.object({ ...byStudent.entries, from: v.optional(isoDate), to: v.optional(isoDate) });

const invalid = (issues: v.BaseIssue<unknown>[]) =>
  text(issues.map(i => `${v.getDotPath(i) ?? 'arguments'}: ${i.message}`).join('; '), true);

const callTool = async (db: Db, name: unknown, args: unknown) => {
  if (name === 'list_students') return text(await listStudents(db));
  if (name === 'get_mocks') {
    const input = v.safeParse(byStudent, args ?? {});
    if (!input.success) return invalid(input.issues);
    const result = await getMocks(db, await tutorTimezone(db), input.output.studentId);
    return result ? text(result) : text('Ученик не найден', true);
  }
  if (name === 'get_lessons') {
    const input = v.safeParse(lessonsInput, args ?? {});
    if (!input.success) return invalid(input.issues);
    const result = await getLessons(db, await tutorTimezone(db), input.output);
    return text(result, typeof result === 'string');
  }
  if (name === 'get_series') {
    const input = v.safeParse(byStudent, args ?? {});
    if (!input.success) return invalid(input.issues);
    return text(await getSeries(db, input.output.studentId));
  }
  throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
};

const handle = async (db: Db, method: string, params: Record<string, unknown>) => {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion:
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(db, params.name, params.arguments);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
};

const requireMcpToken = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (token && (await readToken(c.env, token, 'access'))) return next();
  c.header('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl(c)}"`);
  return c.json({ error: 'invalid_token' }, 401);
});

type RpcMessage = { id?: string | number | null; method?: unknown; params?: Record<string, unknown> };

export const mcpRoutes = new Hono<{ Bindings: Env }>()
  .use(requireMcpToken)
  .post('/', async c => {
    const msg = await c.req.json<RpcMessage>().catch(() => null);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
    }
    // Уведомления и ответы клиента: подтверждаем без тела.
    if (typeof msg.method !== 'string' || msg.id === undefined) return c.body(null, 202);
    try {
      return c.json({ jsonrpc: '2.0', id: msg.id, result: await handle(getDb(c.env), msg.method, msg.params ?? {}) });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      return c.json({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
    }
  })
  // Без SSE-потока и сессий.
  .on(['GET', 'DELETE'], '/', c => c.body(null, 405));
