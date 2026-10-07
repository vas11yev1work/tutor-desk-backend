import { env } from 'cloudflare:workers';
import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';

import { api as request, loginAsAdmin, ORIGIN } from '../../test/helpers';

const VALID = { login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD };

// Свой IP на каждый тест — счётчики попыток не пересекаются.
const login = (body: unknown, ip: string = crypto.randomUUID()) =>
  request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });

const sessionCookie = async () => (await loginAsAdmin()).cookie;

const makeJwt = (exp: number) => sign({ sub: 'admin', iat: exp - 60, exp }, env.JWT_SECRET, 'HS256');
const nowS = () => Math.floor(Date.now() / 1000);

describe('POST /auth/login', () => {
  it('успешный вход ставит HttpOnly SameSite=Lax cookie', async () => {
    const res = await login(VALID);
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).not.toContain('Secure'); // http://localhost
  });

  it('неверный логин и неверный пароль дают одинаковый 401', async () => {
    const badPassword = await login({ ...VALID, password: 'nope' });
    const badLogin = await login({ ...VALID, login: 'nope' });
    expect(badPassword.status).toBe(401);
    expect(badLogin.status).toBe(401);
    expect(await badPassword.text()).toBe(await badLogin.text());
  });

  it('6-я неудачная попытка подряд → 429 с Retry-After', async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 5; i++) expect((await login({ ...VALID, password: 'nope' }, ip)).status).toBe(401);

    const blocked = await login({ ...VALID, password: 'nope' }, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ error: { code: 'too_many_attempts' } });

    // Блокировка действует и на верный пароль.
    expect((await login(VALID, ip)).status).toBe(429);
  });

  it('успешный вход сбрасывает счётчик', async () => {
    const ip = crypto.randomUUID();
    for (let i = 0; i < 4; i++) await login({ ...VALID, password: 'nope' }, ip);
    expect((await login(VALID, ip)).status).toBe(204);

    // Без сброса 6-я неудача подряд уже была бы 429.
    for (let i = 0; i < 5; i++) expect((await login({ ...VALID, password: 'nope' }, ip)).status).toBe(401);
  });
});

describe('сессия', () => {
  it('/auth/me: 200 с cookie, 401 без', async () => {
    expect((await request('/auth/me')).status).toBe(401);
    const res = await request('/auth/me', { headers: { cookie: await sessionCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
  });

  it('logout удаляет cookie', async () => {
    const res = await request('/auth/logout', { method: 'POST', headers: { origin: ORIGIN } });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^session=;/);
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('/admin/*', () => {
  it('без cookie → 401 в едином формате', async () => {
    const res = await request('/admin/students');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized' } });
  });

  it('с валидной cookie → 200', async () => {
    const res = await request('/admin/students', { headers: { ...(await loginAsAdmin()) } });
    expect(res.status).toBe(200);
  });

  it('с просроченным JWT → 401', async () => {
    const res = await request('/admin/students', { headers: { cookie: `session=${await makeJwt(nowS() - 10)}` } });
    expect(res.status).toBe(401);
  });

  it('POST с чужим Origin → 403', async () => {
    const res = await request('/admin/students', {
      method: 'POST',
      headers: { ...(await loginAsAdmin()), origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
