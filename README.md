# Founder Cockpit (Founders App)

The founders' cockpit for the Asqa Zou group: companies, projects, tasks and personal todos for
Nuraaly and Talant. Built with Next.js 15 (App Router), TypeScript, Tailwind CSS v4 and Drizzle ORM
on PostgreSQL. Runs locally with **zero accounts**: without `DATABASE_URL` it uses an embedded
Postgres (PGlite) stored in `./.data/pglite`.

## Run locally (3 commands)

Requires Node.js 22.

```bash
npm install
npm run db:migrate && npm run db:seed
npm run dev
```

Open http://localhost:3000 and sign in as `nuraaly@founders.local` or `talant@founders.local`
with password `founders-dev-2026` (change it with `DEV_FOUNDER_PASSWORD`, see `.env.example`).

Stop `npm run dev` before running `db:*` scripts: the embedded database allows one process at a time.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server (needs `SESSION_SECRET`) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit + service tests (Vitest, in-memory database) |
| `npm run test:e2e` | Playwright smoke test (builds and starts the app on port 3100) |
| `npm run db:generate` | Create a new SQL migration after editing `src/server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (PGlite or `DATABASE_URL`) |
| `npm run db:seed` | Load founders, companies, people and (local DB only, by default) `[sample]` tasks. Safe to re-run: existing founders keep their password |
| `npm run db:reset` | **Local only.** Wipe + migrate + seed. Refuses to run against a non-localhost database |
| `npm run cron:tick` | Run the notification scheduler once against the running app (needs `CRON_SECRET`) |
| `npm run telegram:poll` | Local Telegram bot without a public URL (needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`) |

Screenshots: `SCREENSHOTS=1 npx playwright test screenshots` (writes `docs/screenshots/`).

After pulling new code, run `npm run db:migrate` again (new tables are added by new migrations).

## Moving to Supabase + Vercel later (for a non-developer)

Nothing here costs money on the free tiers. Never paste keys into the code or chat: put them only in
the Vercel / Supabase dashboards.

1. **Create the database.** Sign in at supabase.com → *New project* (region close to Kyrgyzstan,
   e.g. Frankfurt). Save the database password somewhere safe.
2. **Copy the connection string.** Supabase → *Project Settings → Database → Connection string →
   Transaction pooler*. It looks like `postgresql://postgres.xxxx:PASSWORD@aws-0-...pooler.supabase.com:6543/postgres`.
3. **Create the tables once** from your computer:
   create a file `.env.local` with `DATABASE_URL=<that string>` and `DEV_FOUNDER_PASSWORD=<a strong password>`,
   then run `npm run db:migrate` and `npm run db:seed`. Delete `.env.local` afterwards if you like.
   (The seed refuses the dev password or anything shorter than 12 characters on a real database,
   adds no `[sample]` tasks there unless `SEED_SAMPLES=1`, and never changes an existing founder's
   password unless `SEED_RESET_PASSWORDS=1`, which also signs them out everywhere.)
4. **Create the website.** Sign in at vercel.com with GitHub → *Add New → Project* → pick this repository.
5. **Add environment variables** in Vercel → *Settings → Environment Variables*:
   - `DATABASE_URL` = the Supabase connection string from step 2
   - `SESSION_SECRET` = a long random text (on a Mac/Linux: `openssl rand -base64 48`)
   - `AUTH_MODE` = `local`
   - `APP_TIMEZONE` = `Asia/Bishkek`
   - Telegram and scheduler variables: see *Telegram setup* below
6. **Deploy.** Vercel builds automatically on every push. The app refuses to start without
   `SESSION_SECRET`, which protects you from an insecure setup.
7. **Already safe by default:** `npm run db:migrate` turns on row-level security for every
   table and removes all access for Supabase's public `anon`/`authenticated` roles, so the
   Supabase anon key can read nothing. The app itself is unaffected.
8. **Later (developer task):** switch to Supabase Auth (`AUTH_MODE=supabase`, see
   `src/server/auth/supabase.ts`) and, only if a client (e.g. the iOS app) should talk to
   Supabase directly, review and apply `supabase/policies.sql`.

## How access works

- Every page, server action and API route goes through the service layer in `src/server/services/`.
  Access rules live in one place: `src/server/services/access.ts`.
- A **personal todo** (`visibility = private`) is visible only to the founder who created it.
  It can't be assigned to anyone else. Shared tasks need a company and are visible to both founders.
- Company isolation: a task's project must belong to the same company, and a person can only be assigned
  to a task if they work for that company (`person_companies`).
- **Overdue** = not done/cancelled and due date before *today in Asia/Bishkek*. It stays overdue until
  someone moves the deadline or closes the task. Every deadline change is written to `task_events`.
- The task history (`task_events`) follows the same rule as the task: the history of a personal
  todo is visible only to its owner, also after the task was deleted or made private.
- **Company numbers** (metrics, values, connector runs) belong to their company and follow the
  company rule (`visibleMetricsWhere` / `assertMetricAccess` in `access.ts`): shared between the
  founders, never mixed between companies.
- **Salaries are restricted** (see *People and salaries* below): only users in `salary_viewers`
  see or change them. The check is `isSalaryViewer` / `assertSalaryViewer` in `access.ts`, and
  `src/server/services/salaries.ts` is the only code that touches the `salaries` table.

Security notes:

- **Database:** every table has row-level security on and no grants for Supabase's client roles
  (migration `0002_rls_lockdown.sql`). A migration that adds a table must also enable RLS on it;
  `tests/integration/rls.test.ts` fails otherwise. `supabase/policies.sql` holds narrow policies for a
  future direct-client mode (defense in depth; the service layer stays the source of truth).
- **Sign-in limit:** after 10 failed attempts for an email (or 20 from one IP) within 15 minutes,
  sign-in is refused for 15 minutes. Stored in the `login_attempts` table (hashes only).
- **REST API:** changes (`POST/PATCH/DELETE /api/v1/...`) must come from this site (`Origin`) or
  `APP_URL`, and bodies must be JSON. Session cookies are `httpOnly`, `SameSite=Lax`, `Secure` in production.
- **After sign-in** the app only redirects to its own pages.

## Notifications and the Telegram bot

Each founder gets **only their own** messages: a morning summary, an evening check, a
due-today nudge and overdue chases. People records (Edil, Elmurat, …) never receive anything:
the outbox refuses any recipient that is not a founder.

How it works (all in `src/server/notifications/`):

1. A **tick** (every 5–15 minutes) runs the **planner** and then the **dispatcher**.
2. The planner queues, per founder and per day (local time, Asia/Bishkek):
   morning summary (default 08:30), evening check (default 19:00, can be turned off),
   due-today nudge at 12:00, and overdue chases at 10:00 on day 1, 3, 7, then every week.
   Each item has a dedupe key, so running the tick again never queues it twice.
3. **At most one push per task per day.** The due-today nudge, the overdue chase and the
   "Snooze 1 day" reminder share one key per task and local day; the dispatcher double-checks
   before sending. A snoozed task gets only its snooze reminder on the day it fires.
4. The dispatcher sends what is due, following each founder's **Settings**:
   - **Quiet hours** (default 21:00–08:00): everything waits, urgent items too, unless
     "Urgent at night" is on. An evening check inside quiet hours is refused on the Settings
     page (it would expire unseen).
   - **Daily budget**: the two summaries plus at most 3 other pushes (default). Extra items
     are **parked** and listed in the next summary instead of being sent (no spam). Parked
     lines are rebuilt from the task's current state when the summary is sent; tasks that were
     closed or whose deadline moved out of today are dropped.
   - **Urgent tasks**: pushes about tasks with priority *urgent* do not use that budget but
     have their own cap of **2 per day**; beyond that they are parked too. Only a notification
     of kind `urgent` (none is created automatically today) skips the budget entirely.
   - Channel errors are retried after 1, 5, 15, 60 minutes, then marked failed. A Telegram
     call that does not answer within 10 seconds counts as an error.
   - Each item is **claimed** before sending (`status = sending`, wall-clock `claimed_at`,
     `FOR UPDATE SKIP LOCKED`), so overlapping ticks never send the same item twice. A claim
     older than 10 minutes (a crashed run) is taken again and counts as one attempt.
     One broken item is recorded on that item and never stops the run for the others.
5. **Channel:** Telegram when a bot token is set and the founder linked their chat.
   With a token but no linked chat, nothing is sent: items wait as `not_linked` (no budget
   used, parked items stay for later) and go out once the founder links, if still valid
   (e.g. a morning summary only until 6 hours after its time). Without a token everything
   goes to the **dev inbox** (`/dev/notifications`).
   The iOS app can add a `push` channel later in `channels.ts` without touching the rest.

Buttons under task reminders: **Done**, **Snooze 1 day** (moves only the reminder),
**Deadline +1 day / +3 days** (moves the deadline from today if the task is overdue; logged in
the task history). A button carries only a random one-time token stored on the server; it
works only from the chat of the founder it was made for.

Bot commands: `/today`, `/tasks`, `/help`, and `/start CODE` to link. Any chat that is not
linked gets one polite "not linked" reply and nothing else.

### See it working without Telegram

Sign in, open **Settings → Developer tools** (or `/dev/notifications`) and press
**Simulate morning**: the page shows the morning summary you would have received.
These buttons run the scheduler for the signed-in founder only and always deliver into the
dev inbox, never to Telegram (also on a preview with a bot token).
The dev inbox is on in development only; a production build shows it only with `DEV_TOOLS=1`
(fine for preview deployments, never for the real site).

### Telegram setup (for a non-developer, free)

1. **Create the bot.** In Telegram open **@BotFather** → send `/newbot` → choose a name
   (e.g. "Founder Cockpit") and a username ending in `bot` (e.g. `asqa_cockpit_bot`).
   BotFather replies with a **token** like `123456789:AA…`. Treat it like a password:
   do not paste it into chats or into the code.
2. **Make a webhook secret**: any random text of letters/digits, e.g. from
   `openssl rand -hex 32` (or a password manager, 40+ characters, no spaces).
3. **Add environment variables** in Vercel → *Settings → Environment Variables*:
   - `TELEGRAM_BOT_TOKEN` = the token from step 1
   - `TELEGRAM_WEBHOOK_SECRET` = the secret from step 2
   - `TELEGRAM_BOT_USERNAME` = the bot username without `@` (shown on the Settings page)
   - `CRON_SECRET` = another random text (protects the scheduler, see below)

   Then redeploy (Vercel → *Deployments → … → Redeploy*).
4. **Tell Telegram where to deliver messages** (once, from any computer; replace the three
   values):
   ```bash
   curl -sS "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-app>.vercel.app/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   It should answer `{"ok":true,"result":true,"description":"Webhook was set"}`.
   Check any time with `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`.
5. **Link each founder.** Each founder signs in → **Settings** → *Generate link code* →
   sends `/start CODE` to the bot within 15 minutes. The code works once. *Unlink* is on the
   same page.

**Local testing with a real bot (no public URL):** create a *second* bot for development
(Telegram does not allow polling while a webhook is set), put its token and a webhook secret
in `.env.local`, then run `npm run dev` in one terminal and `npm run telegram:poll` in another.
The poller fetches updates from Telegram and forwards them to the same webhook handler.

### Scheduler (cron)

`POST /api/cron/tick` runs plan + dispatch. It needs the header
`Authorization: Bearer <CRON_SECRET>`; anything else gets 401. Call it every 5–15 minutes:

- **Locally:** add `CRON_SECRET=…` to `.env.local`, run the app, then `npm run cron:tick`
  (or use the buttons on `/dev/notifications`).
- **Supabase pg_cron (free):** in Supabase → *Database → Extensions* enable `pg_cron` and
  `pg_net`, store the secret in *Vault* (`select vault.create_secret('<CRON_SECRET>', 'cron_secret');`),
  then in the SQL editor:
  ```sql
  select cron.schedule('founders-tick', '*/10 * * * *', $$
    select net.http_post(
      url := 'https://<your-app>.vercel.app/api/cron/tick',
      headers := jsonb_build_object('Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))
    );
  $$);
  ```
- **Or a free external cron** such as cron-job.org: URL `https://<your-app>.vercel.app/api/cron/tick`,
  method POST, header `Authorization: Bearer <CRON_SECRET>`, every 10 minutes.
  (Vercel's own cron on the free plan runs only once a day, too rare for reminders; the
  endpoint also accepts its GET request if you upgrade later.)

## People and salaries

One shared people database for all companies (it replaces the Excel sheet): **People** in the
sidebar, and the **People** tab of each company (with a headcount per unit, e.g. Alura Style
ХБК / Ош Район; founders are not counted).

- A person has full name (Russian names are fine), short name, phone, Telegram, email, notes.
- A person can work for **several companies** (e.g. the accountant): each company link has a
  role/title, optional unit, employment type (staff / contractor / part-time), start/end date
  and active flag.
- **No hard delete.** *Mark as left* ends all their company roles (end date = today) and hides
  them from active lists; *Left* in the status filter shows them again, with full history.
  Ending one role (*End role*) keeps the person active in their other companies.
  People ids never change, so a later org chart (`org_posts.manager_person_id`) can point at them.

**Salaries (sensitive).**

- Stored in their own table `salaries` (amount, currency default KGS, pay type
  monthly / piecework / hourly, effective from, note, who entered it). A change adds a new row;
  the **current** salary is the latest *effective from* on or before today. History is on the
  person page.
- Only **salary viewers** see them. **Default: only Nuraaly** (pending the founders'
  decision). Change it in **Settings → Access**: one switch per founder, only an existing
  salary viewer can flip it, and the last viewer cannot be removed.
- Everyone else gets no salary column, no salary in the person page, API, search or import
  preview (the key is not even sent), and any salary change is refused (403).
- **Audit:** `salary_access_log` records every change (who, which person, when), every
  grant/revoke of access, and one row per page/API view that showed salaries (not per row).
  Viewers see the latest entries under Settings → Access.

**Import from Excel / CSV** (`/people/import`):

1. Upload a `.xlsx` or `.csv` (max 2 MB; Russian or English headers; CSV in UTF-8 or
   Windows-1251, comma or semicolon). It is parsed in memory on the server and **never stored**:
   the browser sends the file again for each step.
2. Map the columns (guessed from the headers: ФИО, Компания, Должность, Цех, Телефон, Оклад, …).
   Optionally pick a default company for files without a company column.
3. **Preview**: each row is *create*, *update*, *skip* or *error* with the reason (unknown
   company or unit, bad phone/email, salary not a number, empty name, duplicate line).
4. **Import**: error rows are skipped, the rest is written in one transaction.

People are matched by **name + phone** (case and ё/е ignored; `+996 555…` = `0555…`), so
importing the same file again changes nothing. Without a phone, the name must match exactly one
person. Existing values are never overwritten, only empty fields are filled; people marked as
left are not touched. The salary column can only be mapped by a salary viewer; a changed salary
adds a history row. Try it with `docs/samples/people-sample.csv` (clearly fake data).

Parsers: `exceljs` (xlsx) and `papaparse` (csv). The popular `xlsx` (SheetJS) npm package was
not used: its npm version has two unfixed high-severity advisories; `exceljs` has only moderate
ones in its zip-*writing* dependencies, which the importer does not use.

## Company numbers (KPIs)

Each company page has **key numbers** on its *Overview* tab and a **Numbers** tab.
Definitions live in the `metric_definitions` table (seeded by `npm run db:seed` from
`src/lib/kpis.ts`; the seed only adds missing ones, so later edits in the database are kept).
Each metric has a company and optional factory (Alura Style ХБК and Ош Район are separate),
an English name, a unit (KGS, pcs, orders, %, people, count), a period (day / week / month),
whether higher or lower is better, an optional target, and its expected source
(manual, upload or a connector). Marketing (planned) has none yet.

- **KPI card:** latest value and its period, change vs the period right before (green/red by
  direction; nothing when that period is missing), a sparkline of the last 12 periods, who
  updated it and when ("Updated 3 days ago by Talant · via upload"). **Enter value** opens a
  small form on the card.
- **Freshness** (all days are Asia/Bishkek): data for a period is due N days after the period
  ends — daily: 1 day (so a daily number is stale once it is more than 2 days old), weekly:
  3 days (Wednesday), monthly: 10 days (the 10th of the next month); changeable per metric
  (`due_days`). One period overdue → the card turns **warn** (yellow); two or more, or no
  value at all → **risk** (red).
- **Corrections keep history:** values are never overwritten. Entering a different number for
  the same period adds a new row and marks the old one as not current (latest wins). Entering
  the same number again changes nothing.
- **Numbers tab:** a period × metric grid (Monthly / Weekly / Daily) for fast entry. Only changed
  cells are saved; an empty cell never deletes a value.
- **Upload** (`/companies/<slug>/numbers/import`): a `.xlsx` / `.csv` with a **Date** column
  (Дата, Месяц, Period …) and one column per number, named like the card in English or Russian
  ("Orders per day" / "Заказы в день"; factory numbers with the factory: "Выпуск ХБК"). The
  accepted names are listed on the page. Columns are matched to **that company's numbers
  only**, so a file can never change another company. Preview shows each number as *new /
  update / unchanged / error* (bad number, unknown date, future period, same period twice);
  then *Import*. Importing the same file again changes nothing. Same parser and limits as
  the people import. Try `docs/samples/kiwi-go-numbers-sample.csv` (clearly fake numbers).
- **Group overview:** `/companies` and *Today* show one small row per company:
  fresh / stale / missing counts.
- **Morning summary:** a short **Numbers waiting** section (at most 3 lines, grouped by
  company) in each founder's morning summary. No separate pushes; both founders see the same
  list because company data is shared. The hook is `staleMetricsFor(ctx)` in
  `src/server/services/metrics.ts`, so a later agent can chase "please upload X".

**Data sources (connectors).** `src/server/connectors/`: a `Connector` interface (`id`,
`companySlug`, `metrics`, `pull(range) → MetricPoint[]`, `healthCheck()`), a registry, and
placeholders for the **Kiwi Go app**, **WMS (wms.jobutify.com)**, **Alura Style ERP** and
**Wildberries**. The placeholders make **no network calls**; they only report "Waiting for API
access from Edil" / "Needs WB token". `runConnector(db, id, range)` writes what a connector
returns as values with source *connector* and logs every attempt in `connector_runs`. Status
is on *Settings → Data sources* and on each company's Overview (*Check now* logs an attempt).
The env var names are in `.env.example` (all empty). To plug in a real source: implement
`Connector` in its own file, return it from `defaultRegistry()` in `registry.ts`, add its keys
in Vercel.

## REST API (for the future iOS app)

Session-cookie auth for now; JSON errors look like `{ "error": { "code", "message", "fields?" } }`.

- `GET /api/v1/companies`
- `GET /api/v1/tasks?view=my|assigned|company|overdue&companyId=&projectId=&status=&priority=&q=&limit=`
- `POST /api/v1/tasks`
- `GET | PATCH | DELETE /api/v1/tasks/:id`
- `GET /api/v1/people?q=&companyId=&unitId=&status=active|left|all&limit=`
- `POST /api/v1/people` (person + `links[]`; `links[].salary` only for salary viewers)
- `GET /api/v1/people/:id` (all company roles; `salary` and `salaryHistory` only for salary viewers)
- `PATCH /api/v1/people/:id` — person fields (e.g. `{ "status": "left" }`), or
  `{ person, addLinks, updateLinks: [{ id, changes }], addSalaries: [{ linkId, salary }] }`.
  Salary changes from a non-viewer get 403 and nothing is changed.

- `GET /api/v1/companies/:slug/metrics` (definitions with latest value, change, freshness and the last 12 periods)
- `GET /api/v1/metrics/:id/values?history=1&limit=` (current value per period; with `history=1` also corrected rows)
- `POST /api/v1/metrics/:id/values` `{ "period": "2026-10" | "2026-10-31", "value": 123, "note"? }` (201 new, 200 correction/unchanged)

Input shapes are the Zod schemas in `src/lib/schemas.ts`, `src/lib/people-schemas.ts` and `src/lib/metric-schemas.ts`.

## Folder map

```
src/
  app/
    login/                 Sign-in page + server action
    (app)/                 Signed-in app (shell layout)
      page.tsx             Today
      tasks/               Tasks (views, filters, inline edit)
      companies/[slug]/    Company page with tabs (Overview KPI cards, Numbers grid); numbers/import upload
      projects/[id]/       Project with tasks and progress
      people/              People list, person page, new person, import wizard (+ server actions)
      search/ more/ holding/ org/ ai-roles/
      settings/            Own notification preferences + Telegram link; Access (salary viewers)
      dev/notifications/   Dev inbox (dev tools only)
      actions.ts           Server actions (call the service layer)
    api/v1/                REST API (thin, calls the service layer)
    api/telegram/webhook/  Telegram webhook (secret header)
    api/cron/tick/         Scheduler tick (CRON_SECRET)
  components/              UI: shell (sidebar, top bar, tabs), tasks, projects, people, settings
  lib/                     Pure code: dates.ts (timezone), schemas.ts + people-schemas.ts + metric-schemas.ts (Zod),
                           kpis.ts (default metrics), metrics.ts (periods, freshness, change), money.ts
  server/
    auth/                  AuthProvider: local (now) and supabase (stub), session cookie, login rate limit
    db/                    schema.ts, connect.ts (PGlite or Postgres), migrate.ts, seed.ts
    services/              Business logic + access rules (tasks, projects, companies, people, salaries,
                           people-import, metrics, metrics-import, connectors, search, notifications)
    import/parse-table.ts  .xlsx/.csv parsing for the people and numbers imports (in memory, 2 MB limit)
    connectors/            Data sources: Connector interface, registry, stubs (no network), runner
    notifications/         Channels (Telegram, dev, push stub), outbox, planner, dispatcher, bot
    http/request-guard.ts  Same-origin + JSON check for mutating /api/v1 calls
  middleware.ts            Redirects signed-out users to /login (401 JSON for /api), CSRF guard
drizzle/                   SQL migrations (generated by drizzle-kit)
scripts/                   db:migrate / db:seed / db:reset / cron:tick / telegram:poll
supabase/policies.sql      RLS policies for a future direct-client mode (applied by hand)
tests/                     Vitest unit + service tests
e2e/                       Playwright smoke test + screenshots
docs/screenshots/          UI screenshots (company-overview-kpis.png, numbers-grid.png, people-list-salaries.png, …)
docs/samples/              people-sample.csv, kiwi-go-numbers-sample.csv (fake data) for the importers
docs/reviews/              Independent reviews and how each finding was resolved
```
