import { env, exports } from 'cloudflare:workers';

export const ORIGIN = 'http://localhost:5173';

export const api = (path: string, init?: RequestInit) => exports.default.fetch(`http://localhost/api${path}`, init);

export type AdminAuth = { cookie: string; origin: string };

/** Логин через POST /api/auth/login → cookie сессии + разрешённый Origin для CSRF. */
export const loginAsAdmin = async (): Promise<AdminAuth> => {
  const res = await api('/auth/login', {
    method: 'POST',
    // Свой IP на каждый логин — не упираемся в лимит попыток.
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': crypto.randomUUID() },
    body: JSON.stringify({ login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD }),
  });
  if (res.status !== 204) throw new Error(`Логин в тестах не удался: ${res.status}`);
  return { cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '', origin: ORIGIN };
};

/** Запрос к API от имени админа; `body` сериализуется в JSON. */
export const adminApi = (
  auth: AdminAuth,
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
) =>
  api(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
