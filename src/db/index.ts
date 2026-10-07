import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

export const getDb = (env: Env) => drizzle(env.DB, { schema });

export type Db = ReturnType<typeof getDb>;

/** db.batch() для списка произвольной длины (D1 выполняет batch атомарно). */
export const runBatch = async (db: Db, queries: BatchItem<'sqlite'>[]) => {
  const [first, ...rest] = queries;
  if (first) await db.batch([first, ...rest]);
};
