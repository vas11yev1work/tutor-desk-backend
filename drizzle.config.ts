/// <reference types="node" />

import { readdirSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit не читает .dev.vars сам; файла может не быть (например, в CI).
try {
  process.loadEnvFile('.dev.vars');
} catch {
  // переменные берутся из окружения
}

const common = { dialect: 'sqlite', schema: './src/db/schema', out: './drizzle' } as const;

// `bun db:studio:local` — SQLite-файл, который создаёт `wrangler dev` / `bun db:migrate:local`.
const localDbFile = () => {
  const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  const file = readdirSync(dir).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error(`Нет локальной D1 в ${dir}: запусти \`bun db:migrate:local\``);
  return `${dir}/${file}`;
};

export default process.env.DB_LOCAL
  ? defineConfig({ ...common, dbCredentials: { url: localDbFile() } })
  : defineConfig({
      ...common,
      driver: 'd1-http',
      dbCredentials: {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
        databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
        token: process.env.CLOUDFLARE_D1_TOKEN ?? '',
      },
    });
