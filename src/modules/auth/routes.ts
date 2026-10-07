import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';

import { getDb } from '../../db';
import { registerAttempt, resetAttempts } from './attempts';
import { requireAuth } from './middleware';
import { SESSION_COOKIE, SESSION_TTL_S } from './session';

const sha256 = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

// Хеши одинаковой длины → timingSafeEqual не выдаёт длину секрета.
const safeEqual = async (a: string, b: string) => crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));

const isCredentials = (body: unknown): body is { login: string; password: string } =>
  typeof body === 'object' &&
  body !== null &&
  'login' in body &&
  typeof body.login === 'string' &&
  'password' in body &&
  typeof body.password === 'string';

const isHttps = (url: string) => new URL(url).protocol === 'https:';

export const authRoutes = new Hono<{ Bindings: Env }>()
  .post('/login', async c => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isCredentials(body)) {
      return c.json({ error: { code: 'invalid_body', message: 'Нужны строковые login и password' } }, 400);
    }

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

    const iat = Math.floor(now / 1000);
    const token = await sign({ sub: 'admin', iat, exp: iat + SESSION_TTL_S }, c.env.JWT_SECRET, 'HS256');
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_S,
      secure: isHttps(c.req.url),
    });
    return c.body(null, 204);
  })
  .get('/me', requireAuth, c => c.json({ authenticated: true }))
  .post('/logout', c => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c.req.url) });
    return c.body(null, 204);
  });
