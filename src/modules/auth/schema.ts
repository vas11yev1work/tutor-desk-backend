import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Защита логина от перебора: одна строка на IP, удаляется при успешном входе.
export const loginAttempts = sqliteTable('login_attempts', {
  ip: text('ip').primaryKey(),
  failedCount: integer('failed_count').notNull(),
  firstFailedAt: integer('first_failed_at', { mode: 'timestamp_ms' }).notNull(),
  blockedUntil: integer('blocked_until', { mode: 'timestamp_ms' }),
});
