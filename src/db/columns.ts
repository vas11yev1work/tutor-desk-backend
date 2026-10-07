import { integer, text } from 'drizzle-orm/sqlite-core';
import { nanoid } from 'nanoid';

export const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => nanoid());

export const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};
