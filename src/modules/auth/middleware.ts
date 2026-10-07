import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwt } from 'hono/jwt';

import { issueSession, SESSION_COOKIE, SESSION_REFRESH_AFTER_S } from './session';

const isStale = (payload: unknown) =>
  typeof payload === 'object' &&
  payload !== null &&
  'iat' in payload &&
  typeof payload.iat === 'number' &&
  Date.now() / 1000 - payload.iat > SESSION_REFRESH_AFTER_S;

/** JWT из cookie `session`; ошибки hono/jwt → 401 в едином формате. Старую сессию продлевает. */
export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await jwt({ secret: c.env.JWT_SECRET, cookie: SESSION_COOKIE, alg: 'HS256' })(c, next);
  } catch (e) {
    if (e instanceof HTTPException && e.status === 401) return c.json({ error: { code: 'unauthorized' } }, 401);
    throw e;
  }
  if (isStale(c.get('jwtPayload'))) await issueSession(c);
});

/** Проверка Origin для изменяющих запросов; список — в vars ALLOWED_ORIGINS через запятую. */
export const csrfProtection = createMiddleware<{ Bindings: Env }>((c, next) =>
  csrf({ origin: c.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) })(c, next),
);
