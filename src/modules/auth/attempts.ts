import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../db';
import { loginAttempts as t } from './schema';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

/**
 * Засчитывает попытку входа ДО проверки пароля и возвращает конец блокировки (или null).
 * Один атомарный upsert: пачка параллельных запросов не успеет перебрать пароли до блокировки.
 * Успешный вход удаляет строку (resetAttempts), поэтому счётчик фактически считает неудачи.
 */
export const registerAttempt = async (db: Db, ip: string, now: number) => {
  const blocked = sql`${t.blockedUntil} > ${now}`;
  const windowExpired = sql`${t.firstFailedAt} <= ${now - WINDOW_MS}`;

  const [row] = await db
    .insert(t)
    .values({ ip, failedCount: 1, firstFailedAt: new Date(now) })
    .onConflictDoUpdate({
      target: t.ip,
      set: {
        failedCount: sql`CASE WHEN ${blocked} THEN ${t.failedCount} WHEN ${windowExpired} THEN 1 ELSE ${t.failedCount} + 1 END`,
        firstFailedAt: sql`CASE WHEN ${blocked} THEN ${t.firstFailedAt} WHEN ${windowExpired} THEN ${now} ELSE ${t.firstFailedAt} END`,
        blockedUntil: sql`CASE
          WHEN ${blocked} THEN ${t.blockedUntil}
          WHEN ${windowExpired} THEN NULL
          WHEN ${t.failedCount} >= ${MAX_FAILURES} THEN ${now + BLOCK_MS}
          ELSE NULL
        END`,
      },
    })
    .returning({ blockedUntil: t.blockedUntil });

  const blockedUntil = row?.blockedUntil?.getTime() ?? 0;
  return blockedUntil > now ? blockedUntil : null;
};

export const resetAttempts = (db: Db, ip: string) => db.delete(t).where(eq(t.ip, ip));

const sha256 = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

// Хеши одинаковой длины → timingSafeEqual не выдаёт длину секрета.
const safeEqual = async (a: string, b: string) => crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));

/** Логин и пароль админа с защитой от перебора: 'ok', 'invalid' или конец блокировки (ms). */
export const checkCredentials = async (
  db: Db,
  env: Env,
  ip: string,
  input: { login: string; password: string },
  now: number,
) => {
  const blockedUntil = await registerAttempt(db, ip, now);
  if (blockedUntil) return blockedUntil;
  // Обе проверки всегда, без раннего выхода.
  const [loginOk, passwordOk] = await Promise.all([
    safeEqual(input.login, env.ADMIN_LOGIN),
    safeEqual(input.password, env.ADMIN_PASSWORD),
  ]);
  if (!loginOk || !passwordOk) return 'invalid';
  await resetAttempts(db, ip);
  return 'ok';
};
