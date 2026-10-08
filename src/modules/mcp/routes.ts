import { toJsonSchema } from '@valibot/to-json-schema';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';

import { type Db, getDb } from '../../db';
import { ApiError } from '../../lib/errors';
import { readToken, resourceMetadataUrl } from './oauth';
import { readTools } from './tools/read';
import { writeTools } from './tools/write';

/**
 * MCP-сервер (Streamable HTTP, без сессий и SSE): JSON-RPC в POST /api/mcp, ответ — обычный JSON.
 * Инструменты — в ./tools: чтение (ученики, расписание, пробники) и изменение учеников и расписания.
 */

const SERVER_INFO = { name: 'tutor-desk', title: 'Кабинет репетитора', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const INSTRUCTIONS = `Кабинет репетитора по математике: ученики готовятся к ОГЭ, ЕГЭ базе или ЕГЭ профилю.
Пробник — полный вариант экзамена; scores — первичные баллы по номерам заданий (scores[0] — задание 1), null — пробник ещё не проверен.
Максимум и тема каждого номера — в tasks из get_mocks. comment — заметка репетитора к пробнику.
Время везде в поясе репетитора (timezone в ответах), с offset; now в get_lessons — текущий момент.
Регулярные занятия создаются на 8 недель вперёд по правилам из get_series; дальше — только правила.
Изменения: id бери из list_students, get_lessons, get_series. Если неясно, какое занятие или ученик имеется в виду, — переспроси, а не угадывай.
Одно регулярное занятие убирают cancel_lesson; delete_lesson — только для разовых.`;

const TOOLS = [...readTools, ...writeTools];

// inputSchema считается один раз; проверки без аналога в JSON Schema (v.check, trim) просто не попадают в схему.
const TOOL_LIST = TOOLS.map(({ name, title, description, input, annotations }) => {
  const { $schema: _, ...inputSchema } = toJsonSchema(input, { errorMode: 'ignore' });
  return { name, title, description, inputSchema, annotations };
});

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const text = (data: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
  ...(isError ? { isError } : {}),
});

const callTool = async (db: Db, name: unknown, args: unknown) => {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  const input = v.safeParse(tool.input, args ?? {});
  if (!input.success) {
    return text(input.issues.map(i => `${v.getDotPath(i) ?? 'arguments'}: ${i.message}`).join('; '), true);
  }
  try {
    return text(await tool.run(db, input.output));
  } catch (e) {
    // Ошибки сервисов (не найдено, нельзя удалить регулярное, дата в прошлом) — Claude читает их и объясняет.
    if (e instanceof ApiError) return text(e.message, true);
    throw e;
  }
};

/** Иконки фронта кабинета (тот же домен): иначе клиенты берут favicon корневого vslvv.com. */
const serverInfo = (origin: string) => ({
  ...SERVER_INFO,
  websiteUrl: origin,
  icons: [
    { src: `${origin}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: `${origin}/icons/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
  ],
});

const handle = async (db: Db, origin: string, method: string, params: Record<string, unknown>) => {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion:
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: serverInfo(origin),
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOL_LIST };
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
      return c.json({
        jsonrpc: '2.0',
        id: msg.id,
        result: await handle(getDb(c.env), new URL(c.req.url).origin, msg.method, msg.params ?? {}),
      });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      return c.json({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
    }
  })
  // Без SSE-потока и сессий.
  .on(['GET', 'DELETE'], '/', c => c.body(null, 405));
