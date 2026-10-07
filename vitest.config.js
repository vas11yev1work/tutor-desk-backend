import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // ponytail: vitest-pool-workers@0.22 везёт workerd до 2026-08-15, а в wrangler.jsonc дата новее.
        // Убрать, когда пул догонит wrangler.
        compatibilityDate: '2026-08-15',
        // Тестовые секреты, чтобы не зависеть от локального .dev.vars.
        bindings: {
          ADMIN_LOGIN: 'admin',
          ADMIN_PASSWORD: 'test-password',
          JWT_SECRET: 'test-jwt-secret',
          ALLOWED_ORIGINS: 'http://localhost:5173',
          TEST_MIGRATIONS: await readD1Migrations('./drizzle'),
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
});
