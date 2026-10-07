/// <reference types="node" />

import { defineConfig } from 'drizzle-kit';

// drizzle-kit не читает .dev.vars сам; файла может не быть (например, в CI).
try {
  process.loadEnvFile('.dev.vars');
} catch {
  // переменные берутся из окружения
}

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
    token: process.env.CLOUDFLARE_D1_TOKEN ?? '',
  },
});
