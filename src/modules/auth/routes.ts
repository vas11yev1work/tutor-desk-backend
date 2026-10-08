import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import * as v from 'valibot';

import { getDb } from '../../db';
import { onInvalid } from '../../lib/validation';
import { checkCredentials } from './attempts';
import { requireAuth } from './middleware';
import { clearSession, issueSession } from './session';

const credentials = v.object({ login: v.string(), password: v.string() });

export const authRoutes = new Hono<{ Bindings: Env }>()
  .post('/login', sValidator('json', credentials, onInvalid), async c => {
    const now = Date.now();
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const result = await checkCredentials(getDb(c.env), c.env, ip, c.req.valid('json'), now);

    if (typeof result === 'number') {
      c.header('Retry-After', String(Math.ceil((result - now) / 1000)));
      return c.json(
        { error: { code: 'too_many_attempts', message: 'Слишком много попыток входа, попробуйте позже' } },
        429,
      );
    }
    if (result === 'invalid') return c.json({ error: { code: 'invalid_credentials' } }, 401);

    await issueSession(c);
    return c.body(null, 204);
  })
  .get('/me', requireAuth, c => c.json({ authenticated: true }))
  .post('/logout', c => {
    clearSession(c);
    return c.body(null, 204);
  });
