# tutor-desk-backend

API кабинета репетитора: Hono на Cloudflare Workers, файлы в R2, база в D1 (Drizzle ORM).

Код разбит по фичам: `src/modules/<фича>/` (роуты, схема, middleware, тесты).

## Команды

- `bun install` — поставить зависимости
- `bun dev` — локальный сервер `wrangler dev` на http://localhost:8787 (R2 эмулируется локально)
- `bun run deploy` — задеплоить воркер
- `bun cf-typegen` — перегенерировать `worker-configuration.d.ts` после изменений в `wrangler.jsonc`
- `bun lint` / `bun lint:fix` — ESLint
- `bun format` / `bun format:check` — Prettier
- `bun check-types` — tsc
- `bun run test` — тесты (vitest в рантайме Workers; не `bun test`)
- `bun db:generate` — сгенерировать SQL-миграцию в `drizzle/` из `src/db/schema`
- `bun db:migrate:local` / `bun db:migrate:remote` — применить миграции к локальной / продовой D1
- `bun db:studio` — Drizzle Studio против продовой D1
- `bun db:studio:local` — Drizzle Studio против локальной D1 (`.wrangler/state`)

## Первый деплой

1. `bunx wrangler login`
2. `bunx wrangler r2 bucket create tutor-desk-files`
3. Создать D1 (см. «База данных») и применить миграции: `bun db:migrate:remote`
4. Задать секреты (см. «Авторизация») и добавить прод-домен фронта в `vars.ALLOWED_ORIGINS`
5. `bun run deploy`

Проверка: `GET /api/health` → `{ "status": "ok" }`.

## База данных (D1 + Drizzle)

Таблицы живут в модулях (`src/modules/*/schema.ts`) и собираются в `src/db/schema/index.ts` — новую таблицу нужно туда реэкспортировать. Клиент — `getDb(c.env)` из `src/db`.

### Создать базу (один раз)

1. `bunx wrangler d1 create tutor-desk-db`
2. Скопировать `database_id` из вывода в `wrangler.jsonc` → `d1_databases[0].database_id`
3. `bun cf-typegen`

### Миграции

1. Поменять схему в `src/modules/*/schema.ts`
2. `bun db:generate` — появится новый файл в `drizzle/` (коммитить его)
3. `bun db:migrate:local` — применить к локальной базе `wrangler dev` (`.wrangler/state`)
4. `bun db:migrate:remote` — применить к продовой базе перед деплоем

Проверка: `GET /api/health/db` → `{ "db": "ok" }`.

### Drizzle Studio

Локально: `bun db:studio:local` (база появится после `bun db:migrate:local`).

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

## Авторизация

Один администратор (репетитор), без таблицы пользователей. Код — `src/modules/auth`.

- `POST /api/auth/login` `{ login, password }` → 204 + cookie `session` (JWT HS256, 30 дней, HttpOnly, SameSite=Lax, Secure на https)
- `GET /api/auth/me` → `{ authenticated: true }` или 401
- `POST /api/auth/logout` → 204, cookie удалена
- `/api/admin/*` требует cookie; без неё — 401 `{ error: { code: 'unauthorized' } }`
- Изменяющие запросы на `/api/admin/*` и `/api/auth/*` проверяются по Origin (`vars.ALLOWED_ORIGINS` в `wrangler.jsonc`, через запятую)
- Перебор: 5 неудач с одного IP за 15 минут → блокировка на 15 минут (429 + `Retry-After`), таблица `login_attempts`

### Секреты

Локально — в `.dev.vars` (шаблон `.dev.vars.example`). В проде, каждый по разу:

```sh
bunx wrangler secret put ADMIN_LOGIN
bunx wrangler secret put ADMIN_PASSWORD
bunx wrangler secret put JWT_SECRET   # значение: openssl rand -base64 48
```

Смена `JWT_SECRET` разлогинивает все сессии.

## Ученики и расписание

Модули `src/modules/students`, `src/modules/schedule`, `src/modules/portal`. Валидация — Valibot через
`@hono/standard-validator` с общим хуком `onInvalid` (`src/lib/validation.ts`); ошибки — `ApiError`
(`src/lib/errors.ts`) в формате `{ error: { code, message } }`. Даты в API — ISO 8601 (`2026-10-07T18:00:00Z`).

### Админка (`/api/admin`, cookie сессии)

- `GET /students` (без архивных; `?archived=true` — все), `POST /students`, `GET|PATCH /students/:id`
- `POST /students/:id/archive` — завершает правила, удаляет будущие немодифицированные занятия
- `POST /students/:id/regenerate-token` — старая ссылка ученика перестаёт работать
- `POST /series` `{ studentId, weekday, startTime, durationMin, timezone, startsOn }`
- `POST /series/:id/change` `{ fromDate, weekday, startTime, durationMin, timezone }`, `POST /series/:id/end` `{ fromDate }`
- `GET /lessons?from=&to=`, `GET /students/:id/lessons?from=&to=`
- `POST /lessons` (разовое), `PATCH /lessons/:id` (перенос → `isModified`), `POST /lessons/:id/cancel|restore`

### Ученик (`/api/s/:token`, без авторизации, только GET)

- `GET /api/s/:token` → `{ name, grade, exam }`
- `GET /api/s/:token/lessons?from=&to=` → `[{ id, startsAt, durationMin, status }]`

### Как работает расписание

- Правило (`lesson_series`) хранит день недели и время в поясе репетитора; занятия (`lessons`) материализуются
  на 8 недель вперёд. Перевод в UTC — `@date-fns/tz`, поэтому при переходе на зимнее/летнее время локальное время
  не сдвигается.
- Генерация идемпотентна: unique `(series_id, original_starts_at)`.
- Изменение/завершение правила и архивация трогают только будущие занятия с `is_modified = false`;
  дата изменения не может быть в прошлом.
- Cron Trigger `0 3 * * *` (`triggers` в `wrangler.jsonc`) раз в сутки догенерирует занятия.
  Локально: `bunx wrangler dev --test-scheduled`, затем `curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"`.
