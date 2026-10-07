import { Hono } from 'hono';

import { getDb } from '../../db';
import { students } from './schema';

export const studentsRoutes = new Hono<{ Bindings: Env }>().get('/', async c =>
  c.json(await getDb(c.env).select().from(students)),
);
