import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Тема интерфейса — строка без списка: набор тем знает только фронт.
export const DEFAULT_THEME = 'lime';

// Настройки кабинета репетитора: одна строка с id = 1, создаётся при первом сохранении.
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  theme: text('theme').notNull().default(DEFAULT_THEME),
});
