import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
/** Скользящая сессия: JWT старше суток переподписывается ещё на 30 дней при любом авторизованном запросе. */
export const SESSION_REFRESH_AFTER_S = 24 * 60 * 60;

const cookieOptions = (c: Context) =>
  ({ httpOnly: true, sameSite: 'Lax', path: '/', secure: new URL(c.req.url).protocol === 'https:' }) as const;

export const issueSession = async (c: Context<{ Bindings: Env }>) => {
  const iat = Math.floor(Date.now() / 1000);
  const token = await sign({ sub: 'admin', iat, exp: iat + SESSION_TTL_S }, c.env.JWT_SECRET, 'HS256');
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions(c), maxAge: SESSION_TTL_S });
};

export const clearSession = (c: Context) => deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
