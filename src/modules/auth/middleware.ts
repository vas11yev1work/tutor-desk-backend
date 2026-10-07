import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwt } from 'hono/jwt';

import { SESSION_COOKIE } from './session';

/** JWT из cookie `session`; ошибки hono/jwt → 401 в едином формате. */
export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await jwt({ secret: c.env.JWT_SECRET, cookie: SESSION_COOKIE, alg: 'HS256' })(c, next);
  } catch (e) {
    if (e instanceof HTTPException && e.status === 401) return c.json({ error: { code: 'unauthorized' } }, 401);
    throw e;
  }
});

/** Проверка Origin для изменяющих запросов; список — в vars ALLOWED_ORIGINS через запятую. */
export const csrfProtection = createMiddleware<{ Bindings: Env }>((c, next) =>
  csrf({ origin: c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) })(c, next),
);
