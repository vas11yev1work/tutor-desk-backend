import { type Context, Hono } from 'hono';
import { html } from 'hono/html';
import { sign, verify } from 'hono/jwt';
import * as v from 'valibot';

import { getDb } from '../../db';
import { checkCredentials } from '../auth/attempts';
import { csrfProtection } from '../auth/middleware';

/**
 * Минимальный OAuth 2.1 для MCP-коннектора Claude: один пользователь (админ), public client + PKCE.
 * Всё stateless на JWT: client_id общий, код и токены — подписанные JWT.
 * ponytail: код можно обменять повторно в течение 5 минут (нужен code_verifier) и токены не отозвать по одному;
 * отзыв всех — сменить JWT_SECRET. Хранилище кодов/токенов в D1, если понадобится точечный отзыв.
 */

const CODE_TTL_S = 5 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CLIENT_ID = 'claude';
// Колбэки claude.ai (https://support.claude.com/en/articles/11503834) + loopback для Claude Code/Desktop.
const CLAUDE_HOSTS = ['claude.ai', 'claude.com'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

const isAllowedRedirect = (uri: string) => {
  const u = URL.parse(uri);
  if (!u) return false;
  return (
    (u.protocol === 'https:' && CLAUDE_HOSTS.includes(u.hostname)) ||
    (u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname))
  );
};

// Отдельный ключ: cookie-сессия не годится как MCP-токен, и наоборот.
const oauthKey = (env: Env) => `${env.JWT_SECRET}:oauth`;

type TokenType = 'code' | 'access' | 'refresh';

const issue = (env: Env, typ: TokenType, ttl: number, extra: Record<string, string> = {}) => {
  const iat = Math.floor(Date.now() / 1000);
  return sign({ typ, iat, exp: iat + ttl, ...extra }, oauthKey(env), 'HS256');
};

/** Payload валидного токена нужного типа или null. */
export const readToken = async (env: Env, token: string, typ: TokenType) => {
  try {
    const payload = await verify(token, oauthKey(env), 'HS256');
    return payload.typ === typ ? payload : null;
  } catch {
    return null;
  }
};

const base64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const pkceChallenge = async (verifier: string) =>
  base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

const authorizeParams = v.object({
  response_type: v.literal('code'),
  client_id: v.string(),
  redirect_uri: v.pipe(v.string(), v.check(isAllowedRedirect)),
  code_challenge: v.pipe(v.string(), v.minLength(43), v.maxLength(128)),
  code_challenge_method: v.literal('S256'),
  state: v.optional(v.string()),
  scope: v.optional(v.string()),
  resource: v.optional(v.string()),
});

type AuthorizeParams = v.InferOutput<typeof authorizeParams>;

const page = (c: Context, body: ReturnType<typeof html>, status: 200 | 400 | 401 | 429 = 200) => {
  // Страница с паролем не встраивается в чужие фреймы.
  c.header('content-security-policy', "frame-ancestors 'none'");
  return c.html(
    html`<!doctype html>
      <html lang="ru">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Доступ для Claude</title>
          <style>
            body {
              font:
                16px system-ui,
                sans-serif;
              max-width: 360px;
              margin: 12vh auto;
              padding: 0 16px;
            }
            input,
            button {
              display: block;
              width: 100%;
              box-sizing: border-box;
              margin: 8px 0;
              padding: 10px;
              font: inherit;
            }
            .err {
              color: #c00;
            }
          </style>
        </head>
        <body>
          ${body}
        </body>
      </html>`,
    status,
  );
};

const loginForm = (c: Context, params: AuthorizeParams, error?: string, status?: 401 | 429) =>
  page(
    c,
    html`<h1>Доступ для Claude</h1>
      <p>Claude сможет читать учеников, расписание и результаты пробников. Изменять ничего не сможет.</p>
      ${error ? html`<p class="err">${error}</p>` : ''}
      <form method="post">
        ${Object.entries(params).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}" />`)}
        <input name="login" placeholder="Логин" autocomplete="username" required />
        <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required />
        <button>Разрешить</button>
      </form>`,
    status,
  );

const badRequest = (c: Context) =>
  page(
    c,
    html`<h1>Неверный запрос</h1>
      <p>Начните подключение заново из Claude.</p>`,
    400,
  );

const oauthError = (c: Context, error: string, status: 400 | 401 = 400) => c.json({ error }, status);

const tokenResponse = async (c: Context<{ Bindings: Env }>) => {
  c.header('cache-control', 'no-store');
  return c.json({
    access_token: await issue(c.env, 'access', ACCESS_TTL_S),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: await issue(c.env, 'refresh', REFRESH_TTL_S),
  });
};

/** /api/oauth/*: регистрация клиента, вход с согласием, выдача токенов. */
export const oauthRoutes = new Hono<{ Bindings: Env }>()
  // Dynamic Client Registration (RFC 7591): клиента не храним, проверяем только redirect_uris.
  .post('/register', async c => {
    const body = await c.req.json<{ redirect_uris?: unknown }>().catch(() => null);
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every(u => typeof u === 'string' && isAllowedRedirect(u))) {
      return oauthError(c, 'invalid_redirect_uri');
    }
    return c.json(
      {
        client_id: CLIENT_ID,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  })
  .get('/authorize', c => {
    const params = v.safeParse(authorizeParams, c.req.query());
    return params.success ? loginForm(c, params.output) : badRequest(c);
  })
  .post('/authorize', csrfProtection, async c => {
    const form = await c.req.parseBody<Record<string, string>>();
    const params = v.safeParse(authorizeParams, form);
    if (!params.success) return badRequest(c);
    const p = params.output;

    const now = Date.now();
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const result = await checkCredentials(
      getDb(c.env),
      c.env,
      ip,
      { login: String(form.login ?? ''), password: String(form.password ?? '') },
      now,
    );
    if (typeof result === 'number') return loginForm(c, p, 'Слишком много попыток входа, попробуйте позже', 429);
    if (result === 'invalid') return loginForm(c, p, 'Неверный логин или пароль', 401);

    const code = await issue(c.env, 'code', CODE_TTL_S, { cc: p.code_challenge, ru: p.redirect_uri });
    const target = new URL(p.redirect_uri);
    target.searchParams.set('code', code);
    if (p.state !== undefined) target.searchParams.set('state', p.state);
    return c.redirect(target.toString(), 302);
  })
  .post('/token', async c => {
    const form = await c.req.parseBody<Record<string, string>>();
    if (form.grant_type === 'authorization_code') {
      const code = await readToken(c.env, String(form.code ?? ''), 'code');
      const verifier = String(form.code_verifier ?? '');
      if (!code || code.ru !== form.redirect_uri || code.cc !== (await pkceChallenge(verifier))) {
        return oauthError(c, 'invalid_grant');
      }
      return tokenResponse(c);
    }
    if (form.grant_type === 'refresh_token') {
      if (!(await readToken(c.env, String(form.refresh_token ?? ''), 'refresh'))) return oauthError(c, 'invalid_grant');
      return tokenResponse(c);
    }
    return oauthError(c, 'unsupported_grant_type');
  });

const origin = (c: Context) => new URL(c.req.url).origin;

/** Путь к метаданным ресурса — в WWW-Authenticate ответа 401 от /api/mcp. */
export const resourceMetadataUrl = (c: Context) => `${origin(c)}/.well-known/oauth-protected-resource/api/mcp`;

/** Корневые /.well-known/oauth-* (RFC 9728, RFC 8414): клиенты ищут их от корня домена, вне /api. */
export const wellKnownRoutes = new Hono<{ Bindings: Env }>()
  .get('/.well-known/oauth-protected-resource/*', c =>
    c.json({
      resource: `${origin(c)}/api/mcp`,
      authorization_servers: [origin(c)],
      bearer_methods_supported: ['header'],
    }),
  )
  .get('/.well-known/oauth-authorization-server', c =>
    c.json({
      issuer: origin(c),
      authorization_endpoint: `${origin(c)}/api/oauth/authorize`,
      token_endpoint: `${origin(c)}/api/oauth/token`,
      registration_endpoint: `${origin(c)}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }),
  )
  .notFound(c => c.json({ error: 'not_found' }, 404));
