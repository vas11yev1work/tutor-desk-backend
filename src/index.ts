import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from './db';

const app = new Hono<{ Bindings: Env }>().basePath('/api');

app.get('/health', c => c.json({ status: 'ok' }));

app.get('/health/db', async c => {
  await getDb(c.env).run(sql`select 1`);
  return c.json({ db: 'ok' });
});

export default app;
