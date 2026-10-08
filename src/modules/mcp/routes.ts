import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';

import { type Db, getDb } from '../../db';
import { assignments } from '../assignments/schema';
import { EXAM_MAX_SCORES } from '../assignments/scores';
import { listMocks } from '../assignments/service';
import { students } from '../students/schema';
import { readToken, resourceMetadataUrl } from './oauth';
import { EXAM_TOPICS } from './topics';

/**
 * MCP-сервер (Streamable HTTP, без сессий и SSE): JSON-RPC в POST /api/mcp, ответ — обычный JSON.
 * Только чтение: ученики и баллы пробников для аналитики в Claude.
 */

const SERVER_INFO = { name: 'tutor-desk', title: 'Кабинет репетитора', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const INSTRUCTIONS = `Кабинет репетитора по математике: ученики готовятся к ОГЭ, ЕГЭ базе или ЕГЭ профилю.
Пробник — полный вариант экзамена; scores — первичные баллы по номерам заданий (scores[0] — задание 1), null — пробник ещё не проверен.
Максимум и тема каждого номера — в tasks из get_mocks. comment — заметка репетитора к пробнику.`;

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
];

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

const getMocks = async (db: Db, studentId?: string) => {
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
          lessonDate: m.lessonStartsAt,
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

const callTool = async (db: Db, name: unknown, args: unknown) => {
  if (name === 'list_students') return text(await listStudents(db));
  if (name === 'get_mocks') {
    const input = v.safeParse(v.object({ studentId: v.optional(v.string()) }), args ?? {});
    if (!input.success) return text('studentId должен быть строкой', true);
    const result = await getMocks(db, input.output.studentId);
    return result ? text(result) : text('Ученик не найден', true);
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
