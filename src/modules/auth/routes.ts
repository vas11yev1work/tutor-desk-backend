import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import * as v from 'valibot';

import { getDb } from '../../db';
import { onInvalid } from '../../lib/validation';
import { registerAttempt, resetAttempts } from './attempts';
import { requireAuth } from './middleware';
import { clearSession, issueSession } from './session';

const sha256 = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

// Хеши одинаковой длины → timingSafeEqual не выдаёт длину секрета.
const safeEqual = async (a: string, b: string) => crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));

const credentials = v.object({ login: v.string(), password: v.string() });

export const authRoutes = new Hono<{ Bindings: Env }>()
  .post('/login', sValidator('json', credentials, onInvalid), async c => {
    const body = c.req.valid('json');

    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const db = getDb(c.env);
    const now = Date.now();

    const blockedUntil = await registerAttempt(db, ip, now);
    if (blockedUntil) {
      c.header('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      return c.json(
        { error: { code: 'too_many_attempts', message: 'Слишком много попыток входа, попробуйте позже' } },
        429,
      );
    }

    // Обе проверки всегда, без раннего выхода.
    const [loginOk, passwordOk] = await Promise.all([
      safeEqual(body.login, c.env.ADMIN_LOGIN),
      safeEqual(body.password, c.env.ADMIN_PASSWORD),
    ]);
    if (!loginOk || !passwordOk) return c.json({ error: { code: 'invalid_credentials' } }, 401);

    await resetAttempts(db, ip);

    await issueSession(c);
    return c.body(null, 204);
  })
  .get('/me', requireAuth, c => c.json({ authenticated: true }))
  .post('/logout', c => {
    clearSession(c);
    return c.body(null, 204);
  });
