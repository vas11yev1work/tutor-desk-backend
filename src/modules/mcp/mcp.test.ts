import { TZDate } from '@date-fns/tz';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { adminApi, type AdminAuth, api, loginAsAdmin, ORIGIN } from '../../test/helpers';
import { EXAM_MAX_SCORES } from '../assignments/scores';
import type { Lesson } from '../schedule/schema';
import { addDays, isoWeekday, localDate, toUtc } from '../schedule/time';
import type { Student } from '../students/schema';
import { EXAM_TOPICS } from './topics';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(43);
// base64url(sha256(VERIFIER)) — S256-challenge, как его считает клиент.
const CHALLENGE = await crypto.subtle
  .digest('SHA-256', new TextEncoder().encode(VERIFIER))
  .then(b => btoa(String.fromCharCode(...new Uint8Array(b))))
  .then(s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

const PARAMS = {
  response_type: 'code',
  client_id: 'claude',
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'st<"x>',
};

const root = (path: string, init?: RequestInit) => exports.default.fetch(`http://localhost${path}`, init);

const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  // Иначе fetch пойдёт по 302 на claude.ai — а через service binding это снова наш воркер.
  redirect: 'manual' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});

const authorize = (extra: Record<string, string>, ip: string = crypto.randomUUID()) =>
  api('/oauth/authorize', form({ ...PARAMS, ...extra }, { origin: ORIGIN, 'cf-connecting-ip': ip }));

const getCode = async () => {
  const res = await authorize({ login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD });
  expect(res.status, await res.clone().text()).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe(PARAMS.state);
  return location.searchParams.get('code') ?? '';
};

type Tokens = { access_token: string; refresh_token: string; token_type: string };

const exchange = (body: Record<string, string>) => api('/oauth/token', form(body));

const getTokens = async () => {
  const res = await exchange({
    grant_type: 'authorization_code',
    code: await getCode(),
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  expect(res.status).toBe(200);
  return res.json<Tokens>();
};

const post = (token: string, message: unknown) =>
  api('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });

const rpc = (token: string, method: string, params?: unknown) => post(token, { jsonrpc: '2.0', id: 1, method, params });

const callTool = async (token: string, name: string, args: unknown = {}) => {
  const body = await (
    await rpc(token, 'tools/call', { name, arguments: args })
  ).json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>();
  const text = body.result.content[0]?.text ?? '';
  return { isError: body.result.isError, text, data: () => JSON.parse(text) as unknown };
};

it('темы есть для каждого номера каждого экзамена', () => {
  for (const [exam, max] of Object.entries(EXAM_MAX_SCORES)) {
    expect(EXAM_TOPICS[exam as keyof typeof EXAM_TOPICS], exam).toHaveLength(max.length);
  }
});

describe('OAuth', () => {
  it('метаданные в корне домена указывают на /api', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) {
      expect(await (await root(path)).json(), path).toEqual({
        resource: 'http://localhost/api/mcp',
        authorization_servers: ['http://localhost'],
        bearer_methods_supported: ['header'],
      });
    }
    expect(await (await root('/.well-known/oauth-authorization-server')).json()).toMatchObject({
      issuer: 'http://localhost',
      authorization_endpoint: 'http://localhost/api/oauth/authorize',
      token_endpoint: 'http://localhost/api/oauth/token',
      registration_endpoint: 'http://localhost/api/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('регистрация клиента: только колбэки Claude и loopback', async () => {
    const register = (redirect_uris: unknown) =>
      api('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris, client_name: 'Claude' }),
      });
    const ok = await register([REDIRECT, 'http://127.0.0.1:54545/callback']);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ client_id: 'claude', token_endpoint_auth_method: 'none' });
    for (const bad of [['https://evil.com/cb'], ['http://claude.ai/cb'], [], 'x']) {
      expect((await register(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('форма входа: чужой redirect_uri и без PKCE → 400, иначе форма с экранированными полями', async () => {
    const page = (params: Record<string, string>) => api(`/oauth/authorize?${new URLSearchParams(params).toString()}`);
    expect((await page({ ...PARAMS, redirect_uri: 'https://evil.com/cb' })).status).toBe(400);
    expect((await page({ ...PARAMS, code_challenge_method: 'plain' })).status).toBe(400);

    const res = await page(PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('value="st&lt;&quot;x&gt;"');
    expect(html).not.toContain('st<"x>');
  });

  it('вход: неверный пароль → 401 с формой, без Origin → 403, перебор → 429', async () => {
    const bad = await authorize({ login: env.ADMIN_LOGIN, password: 'nope' });
    expect(bad.status).toBe(401);
    const badHtml = await bad.text();
    expect(badHtml).toContain('Неверный логин или пароль');
    // Логин остаётся в поле, пароль — нет.
    expect(badHtml).toContain(`value="${env.ADMIN_LOGIN}"`);
    expect(badHtml).not.toContain('value="nope"');

    const noOrigin = await api(
      '/oauth/authorize',
      form({ ...PARAMS, login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD }),
    );
    expect(noOrigin.status).toBe(403);

    const ip = crypto.randomUUID();
    for (let i = 0; i < 5; i++) await authorize({ login: env.ADMIN_LOGIN, password: 'nope' }, ip);
    expect((await authorize({ login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD }, ip)).status).toBe(429);
  });

  it('код → токены только с верным code_verifier и redirect_uri; refresh выдаёт новые', async () => {
    const code = await getCode();
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER };
    for (const bad of [{ code_verifier: 'b'.repeat(43) }, { redirect_uri: 'http://localhost/cb' }, { code: 'x' }]) {
      const res = await exchange({ ...base, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_grant' });
    }

    const res = await exchange(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const tokens = await res.json<Tokens>();
    expect(tokens.token_type).toBe('Bearer');

    // Access-токен не годится как refresh и наоборот.
    expect((await exchange({ grant_type: 'refresh_token', refresh_token: tokens.access_token })).status).toBe(400);
    expect((await rpc(tokens.refresh_token, 'ping')).status).toBe(401);

    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    expect((await rpc((await refreshed.json<Tokens>()).access_token, 'ping')).status).toBe(200);
  });
});

describe('/api/mcp', () => {
  let token: string;
  let auth: AdminAuth;
  beforeAll(async () => {
    token = (await getTokens()).access_token;
    auth = await loginAsAdmin();
  });

  it('без токена или с cookie-сессией вместо токена → 401 со ссылкой на метаданные', async () => {
    const session = auth.cookie.replace(/^session=/, '');
    const variants: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${session}` },
      { authorization: 'Bearer junk' },
    ];
    for (const headers of variants) {
      const res = await api('/mcp', { method: 'POST', headers, body: '{}' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(
        'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/mcp"',
      );
    }
  });

  it('initialize, уведомления, tools/list, неизвестный метод', async () => {
    const init = await (await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })).json();
    expect(init).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: {
          name: 'tutor-desk',
          websiteUrl: 'http://localhost',
          icons: [
            { src: 'http://localhost/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
            expect.anything(),
          ],
        },
      },
    });
    const unknownVersion = await (await rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).json();
    expect(unknownVersion).toMatchObject({ result: { protocolVersion: '2025-11-25' } });

    expect((await post(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    type Listed = {
      name: string;
      inputSchema: Record<string, unknown>;
      annotations: Record<string, unknown>;
      _meta?: { ui: { resourceUri: string } };
    };
    const list = await (await rpc(token, 'tools/list')).json<{ result: { tools: Listed[] } }>();
    const tools = list.result.tools;
    expect(tools.map(t => t.name)).toEqual([
      'list_students',
      'get_student',
      'get_mocks',
      'get_lessons',
      'get_today',
      'get_series',
      'create_student',
      'update_student',
      'create_lesson',
      'move_lesson',
      'cancel_lesson',
      'restore_lesson',
      'delete_lesson',
      'create_series',
      'change_series',
      'end_series',
    ]);
    // inputSchema собран из valibot: обязательные поля, описания, без $schema.
    const createLesson = tools.find(t => t.name === 'create_lesson');
    expect(createLesson?.inputSchema).toMatchObject({
      type: 'object',
      required: ['studentId', 'date', 'time', 'durationMin'],
      properties: { date: { type: 'string', format: 'date', description: 'YYYY-MM-DD в поясе репетитора' } },
    });
    expect(createLesson?.inputSchema).not.toHaveProperty('$schema');
    expect(tools.find(t => t.name === 'get_lessons')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find(t => t.name === 'delete_lesson')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    // Виджеты MCP Apps: у инструмента ссылка на ui://-ресурс, ресурс отдаёт HTML с нужным mimeType.
    const views = Object.fromEntries(tools.filter(t => t._meta).map(t => [t.name, t._meta?.ui.resourceUri]));
    expect(views).toEqual({
      list_students: 'ui://tutor-desk/students.html',
      get_student: 'ui://tutor-desk/student.html',
      create_student: 'ui://tutor-desk/student.html',
      update_student: 'ui://tutor-desk/student.html',
      get_lessons: 'ui://tutor-desk/week.html',
      get_today: 'ui://tutor-desk/today.html',
    });
    const resources = await (await rpc(token, 'resources/list')).json<{ result: { resources: { uri: string }[] } }>();
    expect(resources.result.resources).toHaveLength(4);
    expect(resources.result.resources[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
    for (const uri of Object.values(views)) {
      const read = await (
        await rpc(token, 'resources/read', { uri })
      ).json<{
        result: { contents: { uri: string; mimeType: string; text: string }[] };
      }>();
      expect(read.result.contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app' });
      expect(read.result.contents[0]?.text).toContain('ui/initialize');
    }
    expect(await (await rpc(token, 'resources/read', { uri: 'ui://nope' })).json()).toMatchObject({
      error: { code: -32002 },
    });

    expect(await (await rpc(token, 'nope')).json()).toMatchObject({ error: { code: -32601 } });
    expect(await (await rpc(token, 'tools/call', { name: 'nope' })).json()).toMatchObject({ error: { code: -32602 } });
    expect((await api('/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  // Правил ещё нет → пояс репетитора UTC; тест расписания ниже создаёт правило в Москве.
  const utc = (iso: Date | string) => new TZDate(+new Date(iso), 'UTC').toISOString();

  it('list_students и get_mocks: баллы по номерам с темами', async () => {
    const student = await (
      await adminApi(auth, '/admin/students', {
        method: 'POST',
        body: { name: 'Аналитика', grade: 11, exam: 'ege_base', notes: 'путает проценты' },
      })
    ).json<Student>();
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const lesson = await (
      await adminApi(auth, '/admin/lessons', {
        method: 'POST',
        body: { studentId: student.id, startsAt, durationMin: 60 },
      })
    ).json<Lesson>();
    const upload = async () => {
      const body = new FormData();
      body.append('file', new File(['%PDF-1.7\nmock'], 'Вариант.pdf'));
      body.append('kind', 'mock');
      const res = await api(`/admin/lessons/${lesson.id}/assignments`, { method: 'POST', headers: auth, body });
      return res.json<{ id: string }>();
    };
    const scored = await upload();
    await upload(); // непроверенный
    const scores = [1, 0, ...Array<number>(19).fill(1)];
    await adminApi(auth, `/admin/assignments/${scored.id}/score`, {
      method: 'PUT',
      body: { scores, comment: 'проценты' },
    });

    const students = (await callTool(token, 'list_students')).data() as Record<string, unknown>[];
    expect(students.find(s => s.id === student.id)).toEqual({
      id: student.id,
      name: 'Аналитика',
      grade: 11,
      exam: 'ege_base',
      contact: null,
      notes: 'путает проценты',
      mocks: 2,
      scoredMocks: 1,
    });

    const one = (await callTool(token, 'get_mocks', { studentId: student.id })).data();
    expect(one).toEqual({
      tasks: {
        ege_base: EXAM_MAX_SCORES.ege_base.map((max, i) => ({
          number: i + 1,
          max,
          topic: EXAM_TOPICS.ege_base[i],
        })),
      },
      students: [
        {
          id: student.id,
          name: 'Аналитика',
          exam: 'ege_base',
          mocks: [
            { number: 1, lessonDate: utc(lesson.startsAt), scores, total: 20, comment: 'проценты' },
            { number: 2, lessonDate: utc(lesson.startsAt), scores: null, total: null, comment: null },
          ],
        },
      ],
    });

    const all = (await callTool(token, 'get_mocks')).data() as { students: { id: string }[] };
    expect(all.students.map(s => s.id)).toContain(student.id);

    expect(await callTool(token, 'get_mocks', { studentId: 'nope' })).toMatchObject({
      isError: true,
      text: 'Ученик не найден',
    });
    expect((await callTool(token, 'get_mocks', { studentId: 1 })).isError).toBe(true);
  });

  it('get_lessons и get_series: время в поясе репетитора, файлы, регулярность', async () => {
    const tz = 'Europe/Moscow';
    const tomorrow = addDays(localDate(Date.now(), tz), 1);
    const student = await (
      await adminApi(auth, '/admin/students', { method: 'POST', body: { name: 'Расписание', exam: 'oge' } })
    ).json<Student>();
    const rule = { weekday: isoWeekday(tomorrow), startTime: '18:00', durationMin: 90, timezone: tz };
    await adminApi(auth, '/admin/series', {
      method: 'POST',
      body: { studentId: student.id, startsOn: tomorrow, ...rule },
    });
    const oneOff = await (
      await adminApi(auth, '/admin/lessons', {
        method: 'POST',
        body: {
          studentId: student.id,
          startsAt: new Date(toUtc(tomorrow, '10:00', tz)).toISOString(),
          durationMin: 60,
        },
      })
    ).json<Lesson>();
    const body = new FormData();
    body.append('file', new File(['%PDF-1.7\nhw'], 'ДЗ.pdf'));
    body.append('kind', 'homework');
    await api(`/admin/lessons/${oneOff.id}/assignments`, { method: 'POST', headers: auth, body });

    type Lessons = { now: string; timezone: string; lessons: Record<string, unknown>[] };
    const week = (await callTool(token, 'get_lessons', { studentId: student.id })).data() as Lessons;
    expect(week.timezone).toBe(tz);
    expect(week.now).toMatch(/\+03:00$/);
    const day = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][rule.weekday - 1];
    const common = { weekday: day, status: 'scheduled', movedFrom: null };
    const who = { id: student.id, name: 'Расписание', grade: null, exam: 'oge' };
    expect(week.lessons).toEqual([
      {
        ...common,
        id: oneOff.id,
        startsAt: `${tomorrow}T10:00:00.000+03:00`,
        durationMin: 60,
        regular: false,
        student: who,
        assignments: [{ kind: 'homework', fileName: 'ДЗ.pdf' }],
      },
      {
        ...common,
        id: expect.any(String) as string,
        startsAt: `${tomorrow}T18:00:00.000+03:00`,
        durationMin: 90,
        regular: true,
        student: who,
        assignments: [],
      },
    ]);

    // Прошлое без занятий; ошибки ввода — isError, а не исключение.
    const past = (
      await callTool(token, 'get_lessons', { studentId: student.id, from: '2020-01-01', to: '2020-01-31' })
    ).data() as Lessons;
    expect(past.lessons).toEqual([]);
    for (const args of [{ from: 'завтра' }, { from: '2020-02-01', to: '2020-01-01' }, { from: '2020-01-01' }]) {
      expect((await callTool(token, 'get_lessons', args)).isError, JSON.stringify(args)).toBe(true);
    }

    expect((await callTool(token, 'get_series', { studentId: student.id })).data()).toEqual([
      {
        id: expect.any(String) as string,
        student: { id: student.id, name: 'Расписание' },
        weekday: day,
        startTime: '18:00',
        durationMin: 90,
        timezone: tz,
        startsOn: tomorrow,
        endsOn: null,
      },
    ]);
  });

  type View = { id: string; startsAt: string; durationMin: number; status: string; regular: boolean };

  it('запись: ученик, разовое занятие, перенос, отмена, удаление', async () => {
    const day = addDays(localDate(Date.now(), 'Europe/Moscow'), 2);
    // create_student и update_student отвечают карточкой ученика (как get_student) — её рисует виджет.
    const card = (
      await callTool(token, 'create_student', { name: '  Через Claude ', exam: 'ege_profile', grade: 11 })
    ).data() as { student: Student; upcoming: unknown[]; mocks: unknown };
    const created = card.student;
    expect(card).toMatchObject({
      student: { name: 'Через Claude', exam: 'ege_profile', grade: 11 },
      upcoming: [],
      mocks: { max: 32, items: [] },
    });
    expect(
      (await callTool(token, 'update_student', { studentId: created.id, notes: 'хочет 80+', grade: null })).data(),
    ).toMatchObject({ student: { name: 'Через Claude', notes: 'хочет 80+', grade: null } });
    expect((await callTool(token, 'create_student', { name: ' ' })).isError).toBe(true);
    expect(await callTool(token, 'update_student', { studentId: 'nope', notes: 'x' })).toMatchObject({
      isError: true,
      text: 'Ученик не найден',
    });

    const call = async (name: string, args: Record<string, unknown>) =>
      (await callTool(token, name, args)).data() as View;
    const lesson = await call('create_lesson', { studentId: created.id, date: day, time: '15:30', durationMin: 60 });
    expect(lesson).toMatchObject({ startsAt: `${day}T15:30:00.000+03:00`, regular: false, status: 'scheduled' });

    // Только время — дата остаётся; только длительность — время остаётся.
    expect(await call('move_lesson', { lessonId: lesson.id, time: '17:00' })).toMatchObject({
      startsAt: `${day}T17:00:00.000+03:00`,
      durationMin: 60,
    });
    expect(await call('move_lesson', { lessonId: lesson.id, durationMin: 90 })).toMatchObject({
      startsAt: `${day}T17:00:00.000+03:00`,
      durationMin: 90,
    });
    expect((await callTool(token, 'move_lesson', { lessonId: lesson.id })).isError).toBe(true);

    expect(await call('cancel_lesson', { lessonId: lesson.id })).toMatchObject({ status: 'cancelled' });
    expect(await call('restore_lesson', { lessonId: lesson.id })).toMatchObject({ status: 'scheduled' });

    expect((await callTool(token, 'delete_lesson', { lessonId: lesson.id })).data()).toEqual({ deleted: lesson.id });
    expect(await callTool(token, 'cancel_lesson', { lessonId: lesson.id })).toMatchObject({
      isError: true,
      text: 'Занятие не найдено',
    });
  });

  it('запись: регулярное расписание — создать, изменить, завершить; регулярное занятие не удалить', async () => {
    const tz = 'Europe/Moscow';
    const start = addDays(localDate(Date.now(), tz), 1);
    const next = addDays(start, 1);
    const { student } = (await callTool(token, 'create_student', { name: 'Регулярный' })).data() as {
      student: Student;
    };
    const lessonsOf = async () =>
      ((await callTool(token, 'get_lessons', { studentId: student.id })).data() as { lessons: View[] }).lessons;

    // Пояс не передан → пояс репетитора (из правила в тесте выше).
    const series = (
      await callTool(token, 'create_series', {
        studentId: student.id,
        startsOn: start,
        weekday: isoWeekday(start),
        startTime: '19:00',
        durationMin: 60,
      })
    ).data() as { id: string };
    expect(series).toMatchObject({ studentId: student.id, startTime: '19:00', timezone: tz, startsOn: start });

    const [regular] = await lessonsOf();
    expect(regular).toMatchObject({ startsAt: `${start}T19:00:00.000+03:00`, regular: true });
    const refused = await callTool(token, 'delete_lesson', { lessonId: regular?.id });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('только отменить');

    const changed = (
      await callTool(token, 'change_series', {
        seriesId: series.id,
        fromDate: start,
        weekday: isoWeekday(next),
        startTime: '20:00',
        durationMin: 45,
      })
    ).data() as { id: string };
    expect(changed).toMatchObject({ startTime: '20:00', durationMin: 45, timezone: tz, startsOn: start });
    expect(changed.id).not.toBe(series.id);
    expect(await lessonsOf()).toMatchObject([{ startsAt: `${next}T20:00:00.000+03:00`, durationMin: 45 }]);

    expect((await callTool(token, 'end_series', { seriesId: changed.id, fromDate: start })).data()).toEqual({
      ended: changed.id,
      lastDay: addDays(start, -1),
    });
    expect(await lessonsOf()).toEqual([]);
    expect((await callTool(token, 'end_series', { seriesId: changed.id, fromDate: '2020-01-01' })).isError).toBe(true);
  });

  it('get_today и get_student: данные для виджетов, structuredContent только у объектов', async () => {
    const tz = 'Europe/Moscow';
    const today = localDate(Date.now(), tz);
    const { student } = (
      await callTool(token, 'create_student', { name: 'Карточка', exam: 'oge', contact: 'Telegram: @kartochka' })
    ).data() as { student: Student };
    // 00:30 сегодня — всегда «сегодня», даже если тест идёт за минуту до полуночи.
    const early = (
      await callTool(token, 'create_lesson', { studentId: student.id, date: today, time: '00:30', durationMin: 30 })
    ).data() as View;
    const later = (
      await callTool(token, 'create_lesson', {
        studentId: student.id,
        date: addDays(today, 3),
        time: '12:00',
        durationMin: 60,
      })
    ).data() as View;

    const day = (await callTool(token, 'get_today')).data() as { now: string; lessons: View[] };
    expect(day.now.slice(0, 10)).toBe(today);
    expect(day.lessons.map(l => l.id)).toContain(early.id);
    expect(day.lessons.map(l => l.id)).not.toContain(later.id);

    const raw = await (
      await rpc(token, 'tools/call', { name: 'get_student', arguments: { studentId: student.id } })
    ).json<{ result: { structuredContent: Record<string, unknown> } }>();
    expect(raw.result.structuredContent).toMatchObject({
      // Claude прислал «Telegram: @…» — сохранился только юзернейм.
      student: { id: student.id, name: 'Карточка', exam: 'oge', contact: 'kartochka' },
      upcoming: [{ id: later.id }],
      series: [],
      mocks: { max: 31, items: [] },
    });
    expect(await callTool(token, 'get_student', { studentId: 'nope' })).toMatchObject({ isError: true });

    // structuredContent обязан быть объектом: у массива (list_students) его нет.
    const list = await (await rpc(token, 'tools/call', { name: 'list_students' })).json<{ result: object }>();
    expect(list.result).not.toHaveProperty('structuredContent');
  });
});
