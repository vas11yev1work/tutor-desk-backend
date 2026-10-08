import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import * as v from 'valibot';

import { getDb } from '../../db';
import { onInvalid } from '../../lib/validation';
import { DEFAULT_THEME, settings } from './schema';

export const themeField = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(50));

export const settingsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async c => {
    const row = await getDb(c.env).select({ theme: settings.theme }).from(settings).get();
    return c.json(row ?? { theme: DEFAULT_THEME });
  })
  .patch('/', sValidator('json', v.object({ theme: themeField }), onInvalid), async c => {
    const { theme } = c.req.valid('json');
    const row = await getDb(c.env)
      .insert(settings)
      .values({ id: 1, theme })
      .onConflictDoUpdate({ target: settings.id, set: { theme } })
      .returning({ theme: settings.theme })
      .get();
    return c.json(row);
  });
