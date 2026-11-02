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
- Salaries are deliberately **not** in `person_companies`; they will get their own restricted table.

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
3. The dispatcher sends what is due, following each founder's **Settings**:
   - **Quiet hours** (default 21:00–08:00): everything waits, urgent items too, unless
     "Urgent at night" is on.
   - **Daily budget**: the two summaries plus at most 3 other pushes (default). Extra items
     are **parked** and listed in the next summary instead of being sent (no spam).
   - Channel errors are retried after 1, 5, 15, 60 minutes, then marked failed.
4. **Channel:** Telegram when a bot token is set and the founder linked their chat;
   otherwise the message is kept in the **dev inbox** (`/dev/notifications`).
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

## REST API (for the future iOS app)

Session-cookie auth for now; JSON errors look like `{ "error": { "code", "message", "fields?" } }`.

- `GET /api/v1/companies`
- `GET /api/v1/tasks?view=my|assigned|company|overdue&companyId=&projectId=&status=&priority=&q=&limit=`
- `POST /api/v1/tasks`
- `GET | PATCH | DELETE /api/v1/tasks/:id`

Input shapes are the Zod schemas in `src/lib/schemas.ts`.

## Folder map

```
src/
  app/
    login/                 Sign-in page + server action
    (app)/                 Signed-in app (shell layout)
      page.tsx             Today
      tasks/               Tasks (views, filters, inline edit)
      companies/[slug]/    Company page with tabs
      projects/[id]/       Project with tasks and progress
      people/ search/ more/ holding/ org/ ai-roles/
      settings/            Own notification preferences + Telegram link
      dev/notifications/   Dev inbox (dev tools only)
      actions.ts           Server actions (call the service layer)
    api/v1/                REST API (thin, calls the service layer)
    api/telegram/webhook/  Telegram webhook (secret header)
    api/cron/tick/         Scheduler tick (CRON_SECRET)
  components/              UI: shell (sidebar, top bar, tabs), tasks, projects
  lib/                     Pure code: dates.ts (timezone), schemas.ts (Zod), kpis.ts
  server/
    auth/                  AuthProvider: local (now) and supabase (stub), session cookie, login rate limit
    db/                    schema.ts, connect.ts (PGlite or Postgres), migrate.ts, seed.ts
    services/              Business logic + access rules (tasks, projects, companies, people, search,
                           notifications: preferences, Telegram link, button actions)
    notifications/         Channels (Telegram, dev, push stub), outbox, planner, dispatcher, bot
    http/request-guard.ts  Same-origin + JSON check for mutating /api/v1 calls
  middleware.ts            Redirects signed-out users to /login (401 JSON for /api), CSRF guard
drizzle/                   SQL migrations (generated by drizzle-kit)
scripts/                   db:migrate / db:seed / db:reset / cron:tick / telegram:poll
supabase/policies.sql      RLS policies for a future direct-client mode (applied by hand)
tests/                     Vitest unit + service tests
e2e/                       Playwright smoke test + screenshots
docs/screenshots/          UI screenshots
docs/reviews/              Independent reviews and how each finding was resolved
```
