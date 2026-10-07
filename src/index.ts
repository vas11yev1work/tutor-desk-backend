import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { getDb } from './db';
import { ApiError } from './lib/errors';
import { assignmentsRoutes } from './modules/assignments/routes';
import { sweepOrphanFiles } from './modules/assignments/service';
import { csrfProtection, requireAuth } from './modules/auth/middleware';
import { authRoutes } from './modules/auth/routes';
import { portalRoutes } from './modules/portal/routes';
import { lessonsRoutes, seriesRoutes } from './modules/schedule/routes';
import { generateAll } from './modules/schedule/service';
import { studentsRoutes } from './modules/students/routes';

const HTTP_CODES: Partial<Record<number, string>> = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden' };

const app = new Hono<{ Bindings: Env }>().basePath('/api');

app.get('/health', c => c.json({ status: 'ok' }));

app.get('/health/db', async c => {
  await getDb(c.env).run(sql`select 1`);
  return c.json({ db: 'ok' });
});

app.use('/auth/*', csrfProtection);
app.use('/admin/*', csrfProtection, requireAuth);

app.route('/auth', authRoutes);
app.route('/admin/students', studentsRoutes);
app.route('/admin/series', seriesRoutes);
app.route('/admin/lessons', lessonsRoutes);
app.route('/admin/assignments', assignmentsRoutes);
// Публичный контур ученика: вне /admin, поэтому auth и csrf на него не действуют.
app.route('/s', portalRoutes);

app.notFound(c => c.json({ error: { code: 'not_found', message: 'Не найдено' } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  if (err instanceof HTTPException) {
    const code = HTTP_CODES[err.status] ?? 'http_error';
    return c.json({ error: { code, message: err.message || code } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: 'internal_error', message: 'Внутренняя ошибка' } }, 500);
});

export default {
  fetch: app.fetch,
  // Cron Trigger (раз в сутки): догенерировать занятия до горизонта 8 недель и подчистить файлы без заданий.
  scheduled: (_controller, env, ctx) => {
    const db = getDb(env);
    ctx.waitUntil(Promise.all([generateAll(db, Date.now()), sweepOrphanFiles(db, env.FILES, Date.now())]));
  },
} satisfies ExportedHandler<Env>;
