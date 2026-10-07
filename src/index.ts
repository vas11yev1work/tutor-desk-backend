import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from './db';
import { csrfProtection, requireAuth } from './modules/auth/middleware';
import { authRoutes } from './modules/auth/routes';
import { studentsRoutes } from './modules/students/routes';

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

export default app;
