# tutor-desk-backend

API кабинета репетитора: Hono на Cloudflare Workers, файлы в R2, база в D1 (Drizzle ORM).

## Команды

- `bun install` — поставить зависимости
- `bun dev` — локальный сервер `wrangler dev` на http://localhost:8787 (R2 эмулируется локально)
- `bun run deploy` — задеплоить воркер
- `bun cf-typegen` — перегенерировать `worker-configuration.d.ts` после изменений в `wrangler.jsonc`
- `bun lint` / `bun lint:fix` — ESLint
- `bun format` / `bun format:check` — Prettier
- `bun check-types` — tsc
- `bun db:generate` — сгенерировать SQL-миграцию в `drizzle/` из `src/db/schema`
- `bun db:migrate:local` / `bun db:migrate:remote` — применить миграции к локальной / продовой D1
- `bun db:studio` — Drizzle Studio против продовой D1

## Первый деплой

1. `bunx wrangler login`
2. `bunx wrangler r2 bucket create tutor-desk-files`
3. Создать D1 (см. «База данных») и применить миграции: `bun db:migrate:remote`
4. `bun run deploy`

Проверка: `GET /api/health` → `{ "status": "ok" }`.

## База данных (D1 + Drizzle)

Схема живёт в `src/db/schema`, клиент — `getDb(c.env)` из `src/db`.

### Создать базу (один раз)

1. `bunx wrangler d1 create tutor-desk-db`
2. Скопировать `database_id` из вывода в `wrangler.jsonc` → `d1_databases[0].database_id`
3. `bun cf-typegen`

### Миграции

1. Поменять схему в `src/db/schema`
2. `bun db:generate` — появится новый файл в `drizzle/` (коммитить его)
3. `bun db:migrate:local` — применить к локальной базе `wrangler dev` (`.wrangler/state`)
4. `bun db:migrate:remote` — применить к продовой базе перед деплоем

Проверка: `GET /api/health/db` → `{ "db": "ok" }`.

### Drizzle Studio

`bun db:studio` ходит в продовую D1 по HTTP API (driver `d1-http`). Нужны переменные в `.dev.vars`
(шаблон — `.dev.vars.example`) или в окружении:

- `CLOUDFLARE_ACCOUNT_ID` — `bunx wrangler whoami`
- `CLOUDFLARE_DATABASE_ID` — тот же id, что в `wrangler.jsonc`
- `CLOUDFLARE_D1_TOKEN` — API token с правом D1:Edit (Dashboard → My Profile → API Tokens)

### Ограничения D1/SQLite в схеме

- нет enum → `text({ enum: [...] })`
- JSON → `text({ mode: 'json' })`
- даты → `integer({ mode: 'timestamp_ms' })`
- нет интерактивных транзакций → `db.batch([...])`
