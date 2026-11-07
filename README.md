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
| `npm run build` / `npm start` | Production build / server (needs `SESSION_SECRET` and `DATABASE_URL`; for a local test on the embedded database add `ALLOW_LOCAL_DB=1`) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit + service tests (Vitest, in-memory database) |
| `npm run test:e2e` | Playwright smoke test (builds and starts the app on port 3100) |
| `npm run db:generate` | Create a new SQL migration after editing `src/server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (PGlite or `DATABASE_URL`) |
| `npm run db:migrate:deploy` | Same, but only when `MIGRATE_ON_BUILD=1` (and `DATABASE_URL` set); otherwise prints "skipped". Uses `MIGRATION_DATABASE_URL` when set. Part of `vercel-build` |
| `npm run db:seed:deploy` | Seed during a deploy: only with `SEED_ON_BUILD=1` + `DATABASE_URL`, and only on a production deploy (`VERCEL_ENV` unset or `production`) while the database does not have **both founders and companies** yet (first deploy, or a seed that failed); same guards as `db:seed`. Otherwise prints "skipped". Part of `vercel-build` |
| `npm run vercel-build` | What Vercel runs (`vercel.json`): `db:migrate:deploy` → `db:seed:deploy` → `next build`. `next build` itself never touches the database |
| `npm run db:seed` | Load founders, companies, people and (local DB only, by default) `[sample]` tasks. Safe to re-run: existing founders keep their password |
| `npm run db:reset` | **Local only.** Wipe + migrate + seed. Refuses to run against a non-localhost database |
| `npm run cron:tick` | Run the notification scheduler once against the running app (needs `CRON_SECRET`) |
| `npm run telegram:poll` | Local Telegram bot without a public URL (needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`) |

Screenshots: `SCREENSHOTS=1 npx playwright test screenshots` (writes `docs/screenshots/`).

After pulling new code, run `npm run db:migrate` again (new tables are added by new migrations).
On Vercel this happens on every deploy (`MIGRATE_ON_BUILD=1`, see below).

## Moving to Supabase + Vercel (click by click, for a non-developer)

Decided: hosting **Vercel Hobby** (free), database **Supabase** (free), sign-in **email +
password**. Nothing below costs money. Keys go **only** into Vercel → *Environment Variables*
(and Supabase's own dashboard) — never into the code, a chat, an email or a screenshot.

**0. Rotate anything that was ever exposed.** If a bot token, the database password or a
secret was ever pasted anywhere (chat, email, code, screenshot), make a new one first:
Telegram **@BotFather** → `/revoke` → pick the bot → it gives a new token; Supabase →
*Project Settings → Database → Reset database password*; secrets below are new random texts.

**1. Supabase: create the database.** supabase.com → *New project* → name `founders-app`,
a strong database password (save it in a password manager), region **Central EU
(Frankfurt)** → *Create new project*. Wait until it is ready (~2 minutes).

**2. Supabase: copy the pooler connection string.** In the project press **Connect** (top
bar) → *Connection String* → *Type: URI* → **Transaction pooler** (port **6543**). It looks
like `postgresql://postgres.abcd1234:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`.
Replace `[YOUR-PASSWORD]` (brackets too) with the database password. This is `DATABASE_URL`.
(Use the pooler, not the "Direct connection": Vercel needs the pooler. The app turns prepared
statements off itself, which the Transaction pooler requires.)

**3. Make the secrets** (on a Mac: Terminal; or a password manager's generator, letters and
digits only): `SESSION_SECRET` = `openssl rand -base64 48`; `TELEGRAM_WEBHOOK_SECRET` and
`CRON_SECRET` = `openssl rand -hex 32` each (different values); `DEV_FOUNDER_PASSWORD` = a
private password of **12+ characters** (both founders' first password). Telegram bot token:
see *Telegram setup* step 1 below.

**4. GitHub: make the app's branch the default one (before Vercel).** Vercel's first deploy
builds the repository's *default branch*. Today that is `main`, which holds only the brief, so
the first deploy would fail. Pick **one** of these two:
- **(a) Approve merging PR #1** (`claude/adoring-brown-rriwam` → `main`) on GitHub: open the
  pull request → *Merge pull request* → *Confirm merge*. Then `main` holds the app; or
- **(b)** GitHub → the `founders-app` repository → **Settings → General → Default branch** →
  the ⇄ button → choose `claude/adoring-brown-rriwam` → *Update* → confirm. Nothing is
  deleted; `main` stays as it is.

**5. Vercel: import the project.** vercel.com → sign in with GitHub → *Add New… → Project* →
*Import* `founders-app` (if it is not listed: *Adjust GitHub App Permissions* and allow it).
Framework: Next.js (detected). Leave *Build Command* alone — `vercel.json` sets it to
`npm run vercel-build`. Open *Environment Variables* on the same screen and add the table
below. **For every variable tick only "Production"** (untick *Preview* and *Development*;
if the import screen has no tick boxes, change them afterwards in *Settings → Environment
Variables* → each variable → *Edit*). Then test links of other branches (*previews*) never
see the real database or the bot; they show an error page — that is expected and harmless.
(Also as a second lock: preview builds never migrate or seed, even if a variable was set for
them by mistake — the build log then says `VERCEL_ENV=preview (not production): skipped`.)

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the pooler string from step 2 | required |
| `SESSION_SECRET` | from step 3 | required |
| `AUTH_MODE` | `local` | |
| `APP_TIMEZONE` | `Asia/Bishkek` | |
| `MIGRATE_ON_BUILD` | `1` | every production deploy applies new migrations first; a failed migration fails the deploy and the old version stays live |
| `SEED_ON_BUILD` | `1` | the first deploy creates the founders, companies and people; later deploys skip it (the database already has founders and companies) |
| `DEV_FOUNDER_PASSWORD` | from step 3 | needed for the first deploy only; you may delete it afterwards |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | |
| `TELEGRAM_WEBHOOK_SECRET` | from step 3 | |
| `TELEGRAM_BOT_USERNAME` | the bot's username without `@` | |
| `CRON_SECRET` | from step 3 | |
| `APP_URL` | optional: `https://<your-project>.vercel.app` | empty = Vercel's production address is used (Settings shows which); set it once you add your own domain |

Press **Deploy**. With step 4 done, this first deploy already builds the app: the build log
shows `[db:migrate:deploy] … done`, `[db:seed:deploy] seeded …` and then the Next.js build.
From now on every push to that branch (the production branch) deploys production by itself.

*Alternative to step 4 (if you skipped it and the first deploy failed or shows an empty
site):* Vercel project → *Settings → Environments → Production → Branch Tracking* (older
screens: *Settings → Git → Production Branch*) → set the branch to
`claude/adoring-brown-rriwam` → *Save*. Then *Deployments* → **…** (top right) → *Create
Deployment* → type `claude/adoring-brown-rriwam` → *Create Deployment*.

**6. Sign in.** Open the site (*Visit*). Sign in as **`nuraaly@founders.local`** or
**`talant@founders.local`** with `DEV_FOUNDER_PASSWORD`. The emails can be changed later
(Supabase → *Table Editor* → `users` → edit `email`; sign in with the new one afterwards —
then do not run `npm run db:seed` by hand any more, it would re-create the old addresses).

**7. Settings → Telegram bot · setup → Connect Telegram.** One press: tells Telegram to
deliver the bot's messages to this site (with the webhook secret) and sets the bot's menu
(/today, /tasks, /help). The card shows the address used and the status (URL set, pending
updates, last error). If a variable is missing it names it — add it in Vercel, *Redeploy*,
press again.

**8. Settings → Reminder clock · setup → Start reminder clock.** One press: the Supabase
database calls the site every 10 minutes (pg_cron + pg_net; the address and `CRON_SECRET`
are stored in Supabase Vault), so reminders and the morning summary go out on time. Press
*Check status* after 10–20 minutes: the job, its last runs and the last answers (200 = fine;
401 = `CRON_SECRET` changed in Vercel → press Start again). Details and fallbacks:
*Scheduler (cron)* below.

**9. Each founder links Telegram.** Each founder: Settings → *Generate link code* → send
`/start CODE` to the bot within 15 minutes.

**Later.** Every push to the production branch (`main` after merging, or `claude/adoring-brown-rriwam`) redeploys and migrates by itself.
Changed `CRON_SECRET` or the address? Press *Start reminder clock* again. Changed the bot
token or the address? Press *Connect Telegram* again.

**Good to know**
- The app refuses to start without `SESSION_SECRET` or `DATABASE_URL` (it never falls back
  to the embedded local database in production: on Vercel that disk is temporary).
- `next build` never touches the database; only `db:migrate:deploy` / `db:seed:deploy` do,
  only with their `…_ON_BUILD=1` flag, and only on a **production** deploy (`VERCEL_ENV` =
  `production`; a preview prints "skipped").
- **If a deploy fails after its migrations ran** (e.g. the Next.js build step fails), the
  previous version stays live — now on the new database tables. That is fine: migrations
  only *add* (tables, columns), so the old version keeps working; fix the build and push
  again. (`db:seed:deploy` runs in one transaction: a failed first seed leaves nothing
  behind and the next deploy seeds again.)
- **One build at a time:** migrations take no lock of their own. Vercel Hobby runs one build
  at a time, so two deploys never migrate at once. On a paid plan with parallel builds, do not
  start two production deploys at the same moment.
- **Migrations through the pooler:** they run through the Transaction pooler (each migration
  is one transaction, no prepared statements). If a future migration ever needs a
  session-level feature, add `MIGRATION_DATABASE_URL` = Supabase *Connect → Session pooler*
  string (same pooler host, port **5432**); migrations then use it, the app keeps
  `DATABASE_URL`.
- **Manual alternative to step 5's automatic migrate/seed:** from your computer with
  `DATABASE_URL=<pooler string>` and `DEV_FOUNDER_PASSWORD=<12+ characters>` in `.env.local`:
  `npm run db:migrate && npm run db:seed` (the seed refuses the dev password or anything
  shorter than 12 characters on a real database, adds no `[sample]` tasks there unless
  `SEED_SAMPLES=1`, and never changes an existing founder's password unless
  `SEED_RESET_PASSWORDS=1`, which also signs them out everywhere). Both are safe to re-run.
- **Already safe by default:** migrations turn on row-level security for every table and
  remove all access for Supabase's public `anon`/`authenticated` roles, so the Supabase anon
  key can read nothing. The app itself is unaffected.
- **Later (developer task):** Supabase Auth (`AUTH_MODE=supabase`, see
  `src/server/auth/supabase.ts`) and, only if a client (e.g. the iOS app) should talk to
  Supabase directly, review and apply `supabase/policies.sql`.

## Environment variables (all of them)

Put them in Vercel → *Settings → Environment Variables* (locally: `.env.local`, see
`.env.example`). Never in the code. *Required* = the production app refuses to start or that
feature stays off without it.

| Variable | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | **Required in production** | Supabase connection string (Transaction pooler). Empty: embedded local database — development only; production refuses to start |
| `ALLOW_LOCAL_DB` | No | `1` lets a *local* production run use the embedded database (e2e). Never on Vercel |
| `SESSION_SECRET` | **Required in production** | Signs the sign-in cookie; 32+ random characters (`openssl rand -base64 48`) |
| `AUTH_MODE` | No | `local` (default, the only one implemented); `supabase` is a stub |
| `APP_TIMEZONE` | No | Business timezone for "today", overdue, schedules and shown times. Default `Asia/Bishkek` |
| `APP_URL` | Recommended | The site's address, e.g. `https://<your-app>.vercel.app`: links in Telegram messages, the webhook *Connect Telegram* sets, the URL *Start reminder clock* calls, an allowed `Origin` for the API; scripts use it to find the app. Empty on Vercel: Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` (then `VERCEL_URL`) is used, with `https://` |
| `MIGRATE_ON_BUILD` | On Vercel: `1` | `1` makes `npm run db:migrate:deploy` (in `vercel-build`) apply migrations on a production deploy (`VERCEL_ENV` unset or `production`; previews skip). Default off ("skipped") |
| `MIGRATION_DATABASE_URL` | No | Optional URL for migrations only (Supabase *Session pooler*, port 5432 on the pooler host). Empty: migrations use `DATABASE_URL` |
| `SEED_ON_BUILD` | On Vercel: `1` | `1` makes `npm run db:seed:deploy` (in `vercel-build`) seed a database that has no founders and companies yet (the first deploy), production deploys only. Default off ("skipped") |
| `DEV_FOUNDER_PASSWORD`, `SEED_RESET_PASSWORDS`, `SEED_SAMPLES` | Seeding only | Used by `npm run db:seed` / `db:seed:deploy` (first deploy), not by the running website. `DEV_FOUNDER_PASSWORD` can be deleted from Vercel after the first deploy |
| `TELEGRAM_BOT_TOKEN` | For Telegram | Bot token from @BotFather. Empty: messages go to the dev inbox only |
| `TELEGRAM_WEBHOOK_SECRET` | For Telegram | Random text; Telegram sends it back with every update |
| `TELEGRAM_BOT_USERNAME` | For Telegram | Bot username without `@` (shown on Settings; used in staff invite links). Empty: `founders_app_bot` |
| `OAUTH_EXTRA_REDIRECT_HOSTS` | No | Claude connector: extra host names (comma-separated, exact, https only) a registered OAuth client may redirect to. Always allowed: `claude.ai`, `claude.com`, `localhost` / `127.0.0.1` (http or https). See *Connect to Claude* |
| `CRON_SECRET` | For reminders | Protects `/api/cron/tick`; without it the scheduler endpoint always answers 401 |
| `DEV_TOOLS` | No | `1` shows the dev inbox in a production build (previews only, never the real site) |
| `FILE_STORAGE` | No | Where document scans go. Empty: local disk in development, **uploads off in production** ("File uploads arrive with Supabase storage"); `local`: local disk on a server with a lasting disk (ignored on Vercel); `supabase`: placeholder, off until written |
| `HOLDING_ACTS_GRACE_DAYS` | No | Days into the next month before a month's акт is expected (default 10) |
| `AI_PROVIDER` | No | Empty / `none` (the only value implemented): AI roles run rule-based, no AI summary |
| `KIWIGO_API_URL`, `KIWIGO_API_TOKEN` | Not used yet | Kiwi Go app data source (from Edil). The connector is a placeholder: no network calls until a developer writes it |
| `WMS_API_URL`, `WMS_API_TOKEN` | Not used yet | WMS (wms.jobutify.com) data source, same as above |
| `ALURA_ERP_API_URL`, `ALURA_ERP_API_TOKEN` | Not used yet | Alura Style ERP data source, same as above |
| `WB_API_TOKEN` | Not used yet | Wildberries seller API token (read-only), same as above |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Not used yet | For the future Supabase Auth / direct-client mode. The anon key can read nothing today (row-level security, see *Good to know* above) |
| `SUPABASE_SERVICE_ROLE_KEY` | Not used yet | For the future Supabase Storage adapter. Server-only: never prefix it with `NEXT_PUBLIC_` |

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
- **Tasks → Team** (`/tasks?view=team`, founders only, `services/team-tasks.ts`): every visible task
  grouped by who has it — one section per founder and person, plus *Unassigned* (shared tasks nobody
  has) — with counts (open, overdue, due today, waiting, done in the last 7 days), each person's
  Telegram status and filters (company, person, status, overdue only). It reads through
  `visibleTasksWhere`, so a founder's personal todos appear only in their own group, to them. It
  reads at most 3000 tasks (`TEAM_TASKS_LIMIT`); beyond that the page says "Showing the first 3000
  tasks only — narrow the filters" (groups and counts then cover only those). The
  person page has a *Tasks* section (overdue / open / done this week) and **Assign a task** (the task
  form preset with that person and their company).
- **Company numbers** (metrics, values, connector runs) belong to their company and follow the
  company rule (`visibleMetricsWhere` / `assertMetricAccess` in `access.ts`): shared between the
  founders, never mixed between companies.
- **Holding** (intercompany flows, акты, договоры, debts, documents) is founders-only
  (`assertHoldingAccess`); documents are served only through an access-checked route.
- **AI roles** (hires, reports, data requests) are founders-only (`assertAiRolesAccess`); a role
  only ever asks or notifies the founders.
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
  `APP_URL`, and bodies must be JSON. The one exception is `POST /api/v1/ingest` (the browser
  extension): it takes no session cookie, only a personal bearer key, and allows
  `chrome-extension://` origins (see *Browser extension*). Session cookies are `httpOnly`, `SameSite=Lax`, `Secure` in production.
- **After sign-in** the app only redirects to its own pages.

## Notifications and the Telegram bot

Each founder gets **only their own** messages: a morning summary, an evening check, a
due-today nudge and overdue chases. People records (Edil, Elmurat, …) receive nothing unless a
founder invited them to the bot and switched them on — see *Team on Telegram* below; founder
kinds can only ever go to founders (the outbox refuses any other recipient).

How it works (all in `src/server/notifications/`):

1. A **tick** (every 5–15 minutes) runs the **planner** and then the **dispatcher**.
2. The planner queues, per founder and per day (local time, Asia/Bishkek):
   morning summary (default 08:30), evening check (default 19:00, can be turned off; sent
   only when something due today is still open or parked items wait that no summary listed
   yet — overdue tasks alone, already in the morning summary, are no reason to message again),
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
     closed or whose deadline moved out of today are dropped, and a task already listed in a
     section of the same message (Overdue, Due today, …) is not repeated under *Parked reminders*.
   - **Folded into the morning summary:** a non-urgent push that would go out within
     **60 minutes before** the founder's morning summary, or anywhere between the end of quiet
     hours and the summary (e.g. a "report ready" push at 08:00 with the summary at 08:30),
     is not sent on its own: it becomes a line of the summary (with the report link) and uses
     no budget. Urgent-priority pushes are never folded.
   - **Urgent tasks**: pushes about tasks with priority *urgent* do not use that budget but
     have their own cap of **2 per day**; beyond that they are parked too. Only a notification
     of kind `urgent` (none is created automatically today) skips the budget entirely.
   - **Founder routines** (see *Routines*): their messages go out only while the budget has
     room but are **not counted** in it; with the budget full they are parked.
   - **Overdue tasks** (Settings → Notifications → *Overdue tasks*, per founder): how the
     chase-day pushes go out. **One push per task** (`separate`, the behaviour described
     above). **One grouped push** (`grouped`, **the default for both founders** — their
     decision; migration 0016 moved saved rows from `separate`): every overdue task due a chase that
     day goes into ONE 10:00 push, "3 tasks need a new deadline", numbered, with a keyboard row
     per task (*1 · Done*, *1 · +1 day*, *1 · +3 days*; at most 10 tasks, then "+N more — open
     the app"). It counts as **one** push against the budget (or against the urgent cap of 2
     when an urgent-priority task leads it), follows quiet hours, the fold-into-summary rule
     and `not_linked` like any push, keeps to Telegram's 4096 characters by listing tasks
     only while they fit (the rest joins "+N more — open the app"; that line and the footer
     always stay; a task not listed has no buttons), and is the day's one push for every task it
     lists (a snooze reminder for such a task that day is cancelled). A task left out (past
     the 10, or cut) is not touched that day — its own row is cancelled `grouped_not_listed`
     even when it was the row the dispatcher picked first; the first listed row then carries
     the message and its buttons. At most **one** grouped push per founder per day, also when
     two ticks overlap (an advisory lock per founder and day): a chase row claimed after it
     is parked (`grouped_already_sent`) and listed in the next summary. If the budget is full it
     is parked like any push. **Morning summary only** (`summary_only`): no overdue chase
     pushes at all; overdue tasks are listed only in the morning summary (due-today nudges,
     snooze reminders and `urgent` notifications still push). Stored in
     `notification_preferences.overdue_chase_style` (migration `0014`).
   - Channel errors are retried after 1, 5, 15, 60 minutes, then marked failed. A Telegram
     call that does not answer within 10 seconds counts as an error.
   - Each item is **claimed** before sending (`status = sending`, wall-clock `claimed_at`,
     `FOR UPDATE SKIP LOCKED`), so overlapping ticks never send the same item twice. A claim
     older than 10 minutes (a crashed run) is taken again and counts as one attempt.
     One broken item is recorded on that item and never stops the run for the others.
5. **Message length:** Telegram allows 4096 characters. The morning summary puts the
   **action items first** (Holding ask, AI role requests), then the task sections, which share
   what is left and end with "+N more — open the app"; parked items and *Numbers waiting* are
   kept whole. If a message still had to be shortened, whole lines are dropped from the end,
   and a Holding ask, AI request or parked item counts as shown only if its line was in the
   message (otherwise it comes again next time).
6. **Channel:** Telegram when a bot token is set and the founder linked their chat.
   With a token but no linked chat, nothing is sent: items wait as `not_linked` (no budget
   used, parked items stay for later) and go out once the founder links, if still valid
   (e.g. a morning summary only until 6 hours after its time). Without a token everything
   goes to the **dev inbox** (`/dev/notifications`).
   The iOS app can add a `push` channel later in `channels.ts` without touching the rest.

Buttons under task reminders: **Done**, **Snooze 1 day** (moves only the reminder),
**Deadline +1 day / +3 days** (moves the deadline from today if the task is overdue; logged in
the task history). A button carries only a random one-time token stored on the server; it
works only from the chat of the founder it was made for.

Bot commands: `/today`, `/tasks`, `/help`, `/stop` (unlinks this chat), and `/start CODE` to link. Any chat that is not
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
4. **Tell Telegram where to deliver messages:** sign in → **Settings → Telegram bot · setup
   → Connect Telegram** (founders only). It calls Telegram's `setWebhook` with
   `<APP_URL>/api/telegram/webhook`, the webhook secret and
   `allowed_updates=["message","callback_query"]`, sets the bot's menu (`setMyCommands`:
   /today, /tasks, /help) and shows `getWebhookInfo`: the URL set, pending updates and the
   last delivery error. It names any missing variable (`APP_URL` — or Vercel's address —
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`). Pressing it again is harmless; press it
   again after changing the token or the site's address. *Check status* only reads.
   Without the button (e.g. another host), the same by hand:
   ```bash
   curl -sS "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-app>.vercel.app/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
5. **Link each founder.** Each founder signs in → **Settings** → *Generate link code* →
   sends `/start CODE` to the bot within 15 minutes. The code works once. *Unlink* is on the
   same page.

**Local testing with a real bot (no public URL):** create a *second* bot for development
(Telegram does not allow polling while a webhook is set), put its token and a webhook secret
in `.env.local`, then run `npm run dev` in one terminal and `npm run telegram:poll` in another.
The poller fetches updates from Telegram and forwards them to the same webhook handler.

### Scheduler (cron) — the reminder clock

`POST /api/cron/tick` runs plan + dispatch. It needs the header
`Authorization: Bearer <CRON_SECRET>`; anything else gets 401. It must be called every 5–15
minutes. Vercel Hobby's own cron runs only **once a day** (too rare, so `vercel.json` has no
crons); the database calls the app instead:

- **Settings → Reminder clock · setup → Start reminder clock** (founders only; the normal
  way). Using the app's own database connection it runs `create extension if not exists
  pg_cron` / `pg_net`, stores the tick URL (`founders_tick_url`) and `CRON_SECRET`
  (`founders_cron_secret`) in **Supabase Vault** (created, or updated when they exist), and
  schedules — or reschedules — the job **`founders-tick`** every 10 minutes. The job's SQL
  only names the Vault entries (neither value is in `cron.job`). *Check status* shows the job,
  its last 5 runs (`cron.job_run_details`) and the last 5 HTTP answers (`net._http_response`).
  Press it again after changing `CRON_SECRET` or the site's address. On a database without
  pg_cron / pg_net / Vault (the local embedded database, a plain Postgres) it says so and
  changes nothing.
- **Manual SQL (same result)** — Supabase → *SQL Editor*, replace the two values once:
  ```sql
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  select vault.create_secret('https://<your-app>.vercel.app/api/cron/tick', 'founders_tick_url');
  select vault.create_secret('<CRON_SECRET>', 'founders_cron_secret');
  select cron.schedule('founders-tick', '*/10 * * * *', $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'founders_tick_url' limit 1),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'founders_cron_secret' limit 1)),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$);
  ```
  (Vault entries already exist? `select vault.update_secret(id, '<new value>') from
  vault.secrets where name = 'founders_cron_secret';`. Running `cron.schedule('founders-tick', …)`
  again replaces the job; `select cron.unschedule('founders-tick');` stops it.)
- **Or a free external cron**, no database involved: cron-job.org → *Create cronjob* → URL
  `https://<your-app>.vercel.app/api/cron/tick`, every 10 minutes, *Advanced*: request method
  **POST**, header `Authorization` = `Bearer <CRON_SECRET>`, timeout 60 s. (Do not use both
  this and the database clock; it is harmless, just double the calls.)
- **Locally:** add `CRON_SECRET=…` to `.env.local`, run the app, then `npm run cron:tick`
  (or use the buttons on `/dev/notifications`).

**Timeouts:** pg_net gives up after **5 seconds** unless told otherwise
(`timeout_milliseconds`); a tick can take longer on a busy morning (several Telegram
messages, AI roles), so the job waits up to 60 s. The route itself may run up to **60 s** on
Vercel (`export const maxDuration = 60` in `src/app/api/cron/tick/route.ts`). A tick that is
cut short is safe: whatever was not sent goes out on the next tick. The endpoint also accepts
Vercel Cron's GET, if you ever upgrade.

## Team on Telegram

Staff (people records: Edil, Elmurat, couriers…) have no app login; they use the **same bot**, in
**Russian**. The bot messages a person only when **both**: they opened a founder's invite link and
pressed *Start* themselves, **and** a founder switched on *Bot may message* for them (and they did
not send `/stop`, are not paused and did not leave). Everything sent is in the outbox log.

**Invite.** Person page or People list → **Invite to Telegram** (founders only) → a one-time code
(15 minutes, stored hashed, single use; a new invite cancels the old one) and the deep link
`https://t.me/<bot>?start=<code>` with a copy button. Send it to the person (WhatsApp, SMS). The bot
is `TELEGRAM_BOT_USERNAME`, or **@founders_app_bot** when that is empty. The code works only in a
private chat, never takes over a founder's chat, and the bot greets the person in Russian.

**Settings → Team on Telegram** (`/settings/team-telegram`): linked / invited people, the *Bot may
message* switch, *Pause until* (a date, or *Resume now*), chase settings per person, the last
messages sent (from the outbox, with status and reason), *Unlink*; and the **defaults for
everyone**. Every timing is a setting — global default → per person → per task (task page):

| Setting | Default | |
| --- | --- | --- |
| Quiet hours | 21:00–08:00 | nothing is sent; messages wait until they end |
| Chase hours | 09:00–20:00 | reminders only inside these hours |
| Chase every | 120 min | one reminder message per person per slot (slots counted from the start of chase hours), listing every task due a chase |
| Max messages per day | 12 | per person; over it a reminder is dropped (the next slot asks again), a new-task message waits for tomorrow |
| Tell the founder after | 3 unanswered reminders | the task's founder gets a push "Edil hasn't confirmed …"; reminders stop until the person answers (0 = never) |
| Tell the founder if still open at | off | e.g. 18:00 on the due day or later: a heads-up push, reminders go on |
| Morning list | off | their open tasks at 09:00 |

Staff are chased **persistently on purpose** (the founders' call: "keep asking until done"),
so they do not use the founders' 3-per-day budget. Stored in `app_settings`
(`staff_notification_defaults`), `people.staff_chase` and `tasks.staff_chase` (migration 0028).

**What the person gets** (planner `planForPerson`, dispatcher `staff-dispatcher.ts`, texts in
`messages-ru.ts`), for open **shared** tasks assigned to them:
- **New task** (once, on the next tick; only tasks assigned after the switch-on, within 3 days): a
  **task card** (HTML, fitted to 4096 characters) — «🆕 Новая задача: …», 🏢 company, 📅 due date, 📝 the
  notes only when a founder ticked *Send the notes to …*, the checklist with ✅ / ⬜ and progress
  («Чек-лист · 1 из 3 ▰▰▱▱▱»), what the person already answered — with **✅ Готово / 👍 Принято /
  💬 Комментарий / 🆘 Нужна помощь / 📅 Перенести срок** and one **⬜ N. item** button per open
  checklist item (at most 8). Every button press **edits that same message** (`editMessageText`) to
  show the new state (✅ item, «👍 Принято 02.11 10:05», «✅ Выполнено: …» without buttons) and the result.
- **Updated card** «✏️ Задача обновлена: …» when a founder changes a task the person already got
  (checklist items added / edited / removed, title, deadline, priority, shared notes): ONE message,
  queued a minute later and built when sent, so several changes in a row are one message
  (`services/task-staff-updates.ts`; kind `staff_task_update`). The app asks first ("Elmurat will get
  an updated message — continue?").
- **Reminders** on the due day and every day after, per the cadence above, until done or escalated:
  **one message per slot**, whatever the number of tasks — one task is «Напоминание: …», several are a
  numbered list with a button row per task (*1 · Готово / 1 · Помощь / 1 · Срок*, at most 8, then
  «…и ещё N — /tasks»). So 8 overdue tasks are 1 message every 2 hours, and the daily cap lasts the
  whole day. No reminder in the slot in which the person was switched on (no burst on switch-on).
  After *Tell the founder after* silent reminders the founder is told; once the person answers and
  then goes quiet again for that many reminders, the founder is told again.
- **Morning list** when switched on for them.
- An info line when a founder approves or declines their deadline request.

**What the person can send back** (always only about **their own** tasks: `staffTasksWhere` in
`access.ts`; buttons carry one-time tokens bound to that person — a forged, another person's or a
founder's token does nothing):
- **Готово** → the task is done (logged in the history as that person) and the task's founder gets
  one line in their next summary (a push if the task is urgent).
- **Принято** → logged (task page → *Timeline*; the card shows «👍 Принято» with the time).
- **Нужна помощь** → a comment on the task + a push to the task's founder.
- **Перенести срок** → +1 / +3 / +7 days → a *request*; the founder approves with one tap (push
  button or the task page). A person can never change a deadline.
- **💬 Комментарий** → the next text (within 30 minutes) becomes a comment on that task; founders get
  one line (a push only for urgent tasks), like any comment. **⬜ item** → ticks it (time + who are kept).
- **Text**: a reply to a task message becomes a comment on that task (the founder gets a line);
  other text → «К какой задаче?» with buttons of their open tasks.
- **Photos / voice / files** → «Пока принимаю только текст»; nothing is stored, the founders get a line.
- Commands: `/tasks` (numbered, with Готово buttons), `/routines` (today's open routines), `/done N`, `/help`, `/stop` (no more messages;
  founders get a line; `/start` turns it back on).

A person's update about a task (done, help, a deadline request, an escalation) is **not** the
founder's "one push per task per day": a help push at 10:00 does not cancel the founder's own 12:00
due-today nudge for that task (it still uses the founder's daily budget). The founder's own Snooze /
Done / +N day never cancels a person's waiting help or deadline-request push, and a deadline request
decided on the task page disappears from the next summary.

**Dev inbox:** *Run tick now* / *Simulate morning* run the founders' reminders only (never staff).
*Simulate staff tick* runs staff reminders and routines at the real current time into the dev inbox;
it is off while a Telegram bot token is set (real people are then messaged by the real clock only).

**Founders' side:** the task page (`/tasks/<id>`, the task title in any list) shows the comment
thread (founders add, edit and delete their own comments), pending deadline requests with
*Approve / Decline*, the timeline ("New task sent 10:00 · Accepted 10:05 · Marked done 11:40") and
the per-task reminders (see *Tasks: the control center* below). Personal todos can never be assigned to a person, so they — and
salaries, holding, numbers — never reach staff. The dev inbox (`/dev/notifications`) lists *Team
messages* too; its buttons carry their callback data (dev channel only) so a developer can press
them through the webhook.

### Tasks: the control center

- **+ New** opens the task form in a **dialog** (as do ✎ Edit and *Assign a task*). Pick the
  **assignee first**: a person limits the companies to the ones they work for now (active link in
  *People*, not left) and a single company is picked for you; the server checks the same (and
  infers the company for a person with one company). Field errors show next to the field; every
  save, tick and button answers with a toast.
- **Every list row** shows status, due date, assignee, company, the last message sent to the person
  (and whether it was delivered), their last answer, comments and checklist progress, with icon
  buttons (accessible names + tooltips): **✓ Done**, **✎ Edit**, **↗ Open**, **🔔 Chase now** (one
  reminder right away through the dispatcher, even while chasing is off or paused; quiet hours and
  their daily cap still apply), **⏸ Pause / ▶ Resume chasing**, **🗄 Archive** (= cancelled, asks
  first; ↺ Restore). Delete is in the edit dialog and asks first.
- **The task page**: *← Back*, the details read-only with the same icon actions, the **checklist**
  (add items one by one with optional details; tick / untick; who and when; removing asks first),
  **Reminders**, comments and the **timeline** (created, status / deadline changes with who and
  when, each message to the person — numbered reminders, delivered or not — and each button they
  pressed).
- **Reminders per task** (segmented control, live plain-language summary under it): *Default* (the
  person's settings) / **Don't chase** / **Remind once on the due date** / **Remind every N hours or
  days until done**; escalation *Default* / **Never tell founders** / **If still open N days after
  due, tell both founders** (once per deadline; reminders go on); and **Founder reminders** for the
  founder who is nudged (assignee founder, else the creator): *Usual* (12:00 on the due date, then
  overdue day 1, 3, 7, weekly) / *Only on the due date* / *Don't nudge* — the founders' quiet hours,
  budget and one-push-per-task rules always apply. Stored in `tasks.staff_chase`
  (`src/lib/task-chase.ts`, `staff-schemas.ts`); global defaults stay in *Settings → Team on Telegram*.
- Data: `task_checklist_items` (migration `0032_task_checklist.sql`, RLS + revoke) and
  `telegram_links.pending_comment_*` for «💬 Комментарий». Services: `task-checklist.ts`,
  `task-activity.ts` (list activity, timeline, Chase now, Pause), `task-staff-updates.ts`.

## Routines

A **routine** is a recurring job assigned to a person (staff, through the bot, in Russian) or a
founder (their normal channel and rules) — e.g. *Kadyr: pick up Wildberries returns, Tue/Wed/Sat
10:00, confirm with Готово*. Founders only: **Routines** in the sidebar (`/routines`), plus a
*Routines* list on each company's Tasks tab and on each person's page.

- **Full CRUD**: create / edit (who does it — a person or a founder; company or group-wide; days of
  the week + time, or a day of the month (31 = the month's last day); time zone Asia/Bishkek;
  confirmation *one button* or *checklist* (one item per line); chase settings), **Pause / Resume**,
  **Archive / Restore** (keeps the history), **Delete** only while a routine never ran, **Run now**
  (opens today's run on any day and asks right away), and the **run history** per routine: *done on
  time*, *done late* (after the "remind until" time or after the founders were told), *partly* (which
  items were missing), *missed*. Filters: company, who, status.
- **Each scheduled day** the planner (`notifications/routine-planner.ts`, every tick) opens a run at
  the ask time (for a person only while the bot may message them — see *Team on Telegram*; the page
  says "Not reachable on Telegram" otherwise) and sends «Рутина: …» with buttons: **Готово**, or for a
  checklist one **«✓ item»** per item plus «✓ Всё сделано». Reminders («Напоминание: …») list **only
  the items not ticked yet**; the run is done when every item is ticked (the founders get one line in
  the next summary). The person's `/routines` command shows today's open runs with their buttons.
- **Every timing is a setting**, routine → the person's chase settings → global staff defaults
  (Settings → Team on Telegram): *remind every* (default the person's "Chase every", 120 min),
  *remind until* (default the end of chase hours), *tell the founders at* (default off) *or after N
  reminders* (default 3), *max messages per day*. One message per run per slot (slot 0 = the ask, then
  every N minutes before "until"; missed slots never pile up), quiet hours hold messages, the person's
  daily cap applies. **Escalation** once per run: a push to both founders ("Elmurat hasn't finished
  "1C…" today — missing: Jobutify, Alura Brand"), following the founders' rules (quiet hours, budget,
  folded into the morning summary). A founder's own routine escalates to the other founder.
  A run that is already open still escalates when the person becomes unreachable during the day
  (`/stop`, paused, bot switched off): no more reminders go to them, and the founders' line says why
  ("… — stopped the bot (/stop), so no more reminders").
- **Missed runs are recorded**: the first tick of the next day closes yesterday's unfinished run as
  *partly* or *missed* and cancels what was still waiting; the next run happens as scheduled.
  A day on which the person was **unreachable on Telegram the whole time** (from the ask time to
  "remind until") gets **no run at all** — nothing is asked, so nothing is recorded as missed; the
  Routines page shows "Not reachable on Telegram" for them.
- **Founder routines** arrive like any other founder push (Telegram or the dev inbox, quiet
  hours; parked ones become "Routine still open: …" in the next summary), buttons *Done* / *✓ item*.
  They have **their own defaults**, not the staff chase: the ask plus **at most one reminder**
  (3 hours later, until the end of the staff working day), no escalation — each field can still be
  set per routine. They **do not use the founder's "max other pushes per day"**: a routine message
  goes out only while that budget still has room and is not counted in it, so task pushes are never
  crowded out; with the budget used up it is parked and listed in the next summary instead.
- **Security**: a button carries a one-time token bound to its owner; a run can be ticked only by the
  routine's assignee (another person's or a forged token does nothing; `tickRoutineRun` re-checks).
- **The founder's first routine — Elmurat, daily 1C financial entries for all companies**: Mon–Sat,
  ask 15:00, remind every 120 min until 19:00, tell the founders at 19:00; checklist = every *active*
  company (Kiwi Go, Jobutify, Alura Brand, Alura Style, Upsell Group, Asqa Zou Holding; Marketing joins
  when it stops being *planned*). `npm run db:seed` creates it once if Elmurat exists as a person and it
  is absent (`src/server/db/example-routines.ts`; never re-created after a founder deleted it). A live
  database seeded before routines existed: **Routines → Use example: Elmurat 1C** (shown while it is absent).
- Data: `routines` and `routine_runs` (migration `0029_routines.sql`, RLS + revoke like every table),
  `notification_action_tokens.routine_run_id` for the buttons. Texts: `messages-ru.ts` (staff),
  `messages.ts` (founders).

## People and salaries

One shared people database for all companies (it replaces the Excel sheet): **People** in the
sidebar, and the **People** tab of each company (with a headcount per unit, e.g. Alura Style
ХБК / Ош Район; founders — people with an app account — are not counted, whatever their role text).
Search ignores case and treats ё and е as the same letter.

- A person has full name (Russian names are fine), short name, phone, Telegram, email, notes.
- A person can work for **several companies** (e.g. the accountant): each company link has a
  role/title, optional unit, employment type (staff / contractor / part-time), start/end date
  and active flag.
- **No hard delete.** *Mark as left* ends all their company roles (end date = the leaving
  date, default today; a future date is refused) and hides them from active lists; *Left* in
  the status filter shows them again, with full history. Undoing it (status *active*) brings
  back exactly the roles that *Mark as left* ended; roles ended by hand stay ended.
  Ending one role (*End role*) keeps the person active in their other companies.
  People ids never change, so a later org chart (`org_posts.manager_person_id`) can point at them.

**Salaries (sensitive).**

- Stored in their own table `salaries` (amount, currency default KGS, pay type
  monthly / piecework / hourly, effective from, note, who entered it). A change adds a new row;
  the **current** salary is the latest *effective from* on or before today (same date: the row
  entered last). History is on the person page. A salary row and its audit row are written
  together or not at all.
- Only **salary viewers** see them. **Default: both founders** (their decision; the seed adds
  both on a new database, migration 0016 added Talant on an existing one). Change it in **Settings → Access**: one switch per founder, only an existing
  salary viewer can flip it, and the last viewer cannot be removed (also when two viewers
  revoke each other at the same moment: the rows are locked, so one of the two is refused).
  A viewer must also still be a founder in the database.
- Everyone else gets no salary column, no salary in the person page, API, search or import
  preview (the key is not even sent), and any salary change is refused (403).
- **Audit:** `salary_access_log` records every change (who, which person, when), every
  grant/revoke of access, and one row per page/API view that showed salaries (not per row).
  Viewers see the latest entries under Settings → Access. Access granted by the system (the
  seed, migration 0016) shows actor **System** (scope `system:seed` / `system:migration`;
  migration 0018 added the rows missing for grants made before this was logged).

**Import from Excel / CSV** (`/people/import`):

1. Upload a `.xlsx` or `.csv` (max 2 MB; Russian or English headers; CSV in UTF-8,
   UTF-16 with BOM or Windows-1251, comma or semicolon). It is parsed in memory on the server
   and **never stored**: the browser sends the file again for each step. An `.xlsx` is a zip:
   it is refused if it has more than 100 parts or unpacks to more than 10 MB per part / 25 MB
   in total (checked while unpacking, so a "zip bomb" cannot exhaust the server).
2. Map the columns (guessed from the headers: ФИО, Компания, Должность, Цех, Телефон, Оклад, …).
   Optionally pick a default company for files without a company column.
3. **Preview**: each row is *create*, *update*, *skip* or *error* with the reason (unknown
   company or unit, bad phone/email, salary not a number, empty name, duplicate line).
4. **Import**: error rows are skipped, the rest is written in one transaction. The file must be
   the one that was previewed (its sha256 is checked), and two imports at the same moment run
   one after the other (database lock), so they cannot both create the same person.

People are matched by **name + phone** (case and ё/е ignored; `+996 555…` = `0555…`), so
importing the same file again changes nothing. Without a phone, the name must match exactly one
person. A person without a phone is matched by the *first* row with that name and gets its
phone; another row with the same name and a different phone is a new person (two people are
never merged). Existing values are never overwritten, only empty fields are filled; people
marked as left are not touched. The salary column can only be mapped by a salary viewer (also
not to another field such as notes); a changed salary adds a history row. For viewers the
preview shows *current → new* amounts and flags every **decrease** in red with a warning on
top (an old file would otherwise undo raises). Try it with `docs/samples/people-sample.csv` (clearly fake data).

**Exports:** none yet. Any future CSV export must build its cells with `csvSafe` /
`toCsvLine` (`src/lib/csv-safe.ts`): text starting with `=`, `+`, `-`, `@`, tab or CR gets a
leading `'` so Excel does not run it as a formula.

Parsers: `exceljs` (xlsx), `jszip` (the zip check before it) and `papaparse` (csv). The popular `xlsx` (SheetJS) npm package was
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
  direction; nothing when that period is missing; today's daily number is marked "so far"
  and never compared), a sparkline of the last 12 periods, who updated it and when
  ("Updated 3 days ago by Talant · via upload"), and "Source disagrees: … says X (kept Y)"
  when a data source reported another number than the one entered by hand. **Enter value**
  opens a small form on the card, set to the oldest missing period.
- **Month totals (daily numbers):** under the daily Numbers grid a *Month totals* table takes
  one value per finished month for each daily number (total / average / end-of-month value by
  its aggregation). It is used only by AI roles set to accept monthly totals (see *AI roles*)
  and never mixes into the days, the card, the sparkline or freshness.
- **Only finished periods:** daily numbers may be entered for today; weekly and monthly numbers
  only for a **finished** week / month ("This month isn't finished yet"), so a month-to-date
  total is never stored as the month's number. Future periods are refused everywhere.
- **Exact numbers, no guessing:** "85.000" or "12,345" (thousands or decimals?) are refused
  with a hint, "%" is accepted only for percentage numbers, at most 4 decimals and 15 digits.
  `.xlsx` numbers are read from the stored value, never the display text: a cell showing
  95.5 % (Excel stores 0.955) is 95.5, and 1 234 567.89 keeps its decimals. The people import
  reads salaries the same way (more than 2 decimals is refused, never rounded).
  A REST `period` must be a date (`2026-10-31` or `2026-10`), not a timestamp.
  `note`: omitted keeps the existing note, `null` or `""` removes it.
- **Freshness** (all days are Asia/Bishkek): data for a period is due N days after the period
  ends — daily: 1 day (so a daily number is stale once it is more than 2 days old), weekly:
  3 days (Wednesday), monthly: 10 days (the 10th of the next month); changeable per metric
  (`due_days`). Gaps are counted inside a window of the last **7 days / 4 weeks / 3 months**
  of due periods (periods before a number's first value don't count), also behind a later
  value: one missing → **warn** (yellow) with "Waiting for …", two or more → **risk** (red)
  with "N missing"; no value at all → **risk**.
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
  update / unchanged / error* (bad or ambiguous number, unknown date, future or unfinished
  period, a month label like "Oct 2026" in a daily/weekly column, or several rows landing in
  one period of a number — e.g. a daily file in a monthly column: **all** of those rows are
  refused, the first one is not kept);
  then *Import*. Importing the same file again changes nothing. Same parser and limits as
  the people import (zip-bomb guard, same-file check, one import per company at a time). Try `docs/samples/kiwi-go-numbers-sample.csv` (clearly fake numbers).
- **Group overview:** `/companies` and *Today* show one small row per company:
  fresh / stale / missing counts.
- **Morning summary:** a short **Numbers waiting** section in each founder's morning summary.
  Numbers that had data and are late: every day, at most 3 lines grouped by company. On
  **Mondays only**: one line for numbers that were never entered, and one line for numbers
  that wait for a data source that is not set up ("18 numbers wait for data sources (Edil's
  APIs, WB token)"); numbers an AI role is already asking for (by hand or upload until the source
  is connected) are left out of that line. No separate pushes; both founders see the same list because company
  data is shared. The hook is `staleMetricsFor(ctx)` in
  `src/server/services/metrics.ts`, so a later agent can chase "please upload X".

**Data sources (connectors).** `src/server/connectors/`: a `Connector` interface (`id`,
`companySlug`, `metrics`, `setup()` (static, no network), `healthCheck()`,
`pull(range, { signal, cursor })` → points or a page with `nextCursor`), a registry, and
placeholders for the **Kiwi Go app**, **WMS (wms.jobutify.com)**, **Alura Style ERP** and
**Wildberries**. The placeholders make **no network calls**; they only report "Waiting for API
access from Edil" / "Needs WB token". `runConnector(db, id, range)` writes what a connector
returns as values with source *connector* and logs every attempt in `connector_runs` (status
*running* until it is finalised; the pull has a 60 s time limit and at most 50 pages).
Rules: a connector **never overwrites a number entered or uploaded by a founder** (a different
number is recorded as a conflict in the run's `details` and shown on the card); weekly /
monthly numbers are written only for finished periods; daily points for a weekly / monthly
number are combined by the metric's `aggregation` (*sum* for orders and money, *avg* for %,
*last* for people counts and balances) only when every day of the period was received.
Status is on *Settings → Data sources* and on each company's Overview; pages show the
static setup and the **last check** only — the source itself is contacted only by
*Check now* (range: from the 1st of last month to yesterday).
The env var names are in `.env.example` (all empty). To plug in a real source: implement
`Connector` in its own file, return it from `defaultRegistry()` in `registry.ts`, add its keys
in Vercel.

## Holding (intercompany акты, договоры, debts)

`/holding` (sidebar → Group → Holding). Founders only (`canSeeHolding` / `assertHoldingAccess`
in `access.ts`); all logic in `src/server/services/holding.ts` (+ `holding-asks.ts`,
`holding-files.ts`), pure rules in `src/lib/holding.ts`. Nothing is hard-deleted: flows,
договоры and ledger entries are **archived**.

- **Flows** (`intercompany_flows`): from company → to company, service ("пошив"), since,
  optional until, status *active* / *planned*. Seeded (`db:seed`, only missing ones): Alura
  Style → Alura Brand · пошив; Jobutify → Alura Style · ERP; Jobutify → Kiwi Go · приложение
  и платформа; Kiwi Go → Alura Brand · доставка; Marketing → each company · маркетинг
  (*planned*, no акты expected). **Start dates are unknown**, so a real database gets the
  active flows *without* a start date ("Set the start date" tag): nothing is expected and
  nobody is asked until a founder sets it. The local sample seed uses 1 Jan 2026.
  The two companies of a flow can't be changed (archive it and add a new one).
- **Акты grid** (`intercompany_acts`, one row per flow per month, written the first time a
  founder changes a cell): rows = active flows, columns = the last 12 finished months + the
  current one. Green = signed / received, yellow = requested (asked on a date), red =
  missing, grey = not needed / before the flow started, dashed = not due yet. A month is
  **expected** from the 1st of the next month + a grace of **10 days**
  (`HOLDING_ACTS_GRACE_DAYS`): October from 11 November; the current month never. Click a
  cell → panel: status, amount (KGS, exact, max 2 decimals, "85.000" refused as ambiguous),
  act number / date, "asked on", note, scan. A recorded status always wins (an акт received
  early shows green). **Months older than the grid** (a flow that started more than a year
  ago) are not columns, but the flow row shows "N older missing" (click opens the oldest),
  they count in "Missing акты" and are included in the ask and the message to copy.
- **Archived flows:** their акты still count in the debts (an акт is a real invoice), so in
  *Flows → Show archived → Correct акты* a founder can still change the **status, amount and
  act date** of an акт already recorded on an archived flow. Nothing else (no new акты, no
  "requested", no notes or scans) until the flow is restored.
- **Договоры** (`intercompany_contracts`): flow, number, signed on, valid until, status
  draft / signed / expired / terminated, amount terms, optional scan. A *signed* contract
  ending within **30 days** shows "Ends in N days"; one whose end date passed shows "Ended N
  days ago — renew or mark as expired".
- **Debts** (derived, `intercompany_ledger_entries` for the rest): an акт with an amount that
  is *received* or *signed* means the receiving company owes the providing one (dated by its
  act date, else the month's last day); plus opening balances and payments entered by hand.
  Both directions are netted per pair ("Alura Brand owes Alura Style 1 240 000 KGS") and
  summed (exact to the tyiyn). A wrong entry is cancelled (archived), never deleted.
- **Metric feed:** the Holding KPI "Intercompany debt total" gets, for each month, the total
  **as of that month's last day**, source `derived` (new value of the `metric_source` enum).
  Every scheduler tick writes the latest finished month; a change that affects debts (an
  акт's amount / status / date, a payment or opening balance, a cancelled entry) recomputes
  **every month from the earliest month it touches** up to the latest finished one, so a late
  September акт also corrects October. Only months whose value is `derived` (or empty) are
  written: a number a founder entered or uploaded (or a connector's) is never replaced (the
  card keeps it). Months without any debt data stay empty — except a month that already had
  a derived value (e.g. every entry was cancelled since): it gets **0**, a new version with
  history, rather than keeping a stale total (values are never deleted).
- **Documents:** PDF, JPG or PNG, max **10 MB**; the type is decided by the file's first bytes
  (a renamed .html is refused). Uploaded with `POST /api/v1/holding/files` (multipart — the
  only non-JSON endpoint; it requires an `Origin` of this site or `Sec-Fetch-Site:
  same-origin`, see `request-guard.ts`) and served only to signed-in founders by
  `GET /api/v1/holding/files/:id` (`nosniff`, `no-store`; images also get a sandbox CSP, PDFs
  not — Chrome's PDF viewer refuses to render sandboxed documents). Bytes go through
  `FileStorage` (`src/server/storage/file-storage.ts`): local disk `.data/uploads` now,
  a `SupabaseFileStorage` placeholder (no network) for later. **On Vercel the local disk is
  read-only and not kept**, so uploads are **switched off in production** unless a storage that
  keeps files is chosen with `FILE_STORAGE`:
  - empty (default): local disk in development; in production uploads are off — the scan
    fields show "File uploads arrive with Supabase storage" and `POST /api/v1/holding/files`
    answers **503** with that message (everything else on /holding works);
  - `supabase`: the placeholder adapter — still off until a developer writes it;
  - `local`: the local disk, as an explicit choice for a server with its own lasting disk (or
    a local production test; e2e sets it). Ignored on Vercel (`VERCEL=1`).
  The metadata row is written before the bytes (a failed write removes the row), and uploads
  never attached to an акт or договор are removed after **24 h** by the scheduler tick (20
  per run); a document attached once is never removed. `next.config.ts` raises
  `middlewareClientMaxBodySize` to 11 MB so a file near 10 MB is not cut off by the
  middleware; anything over 10 MB gets a 413 with a clear message.
  **Vercel limit:** Vercel refuses request bodies over **4.5 MB** before they reach the app,
  so on Vercel scans above ~4.5 MB will fail until the Supabase storage adapter is written
  with a **signed direct upload** (the browser uploads straight to Supabase Storage with a
  short-lived URL the server signs; the app only records the metadata).

### Who to ask, and pushing the founders to ask

**Who to ask.** Every flow has an optional **"Who to ask"** person (*Flows → Edit → Who to
ask for the акты*): anyone who works for **either company of the flow** (an active link in
People, not marked as left; the founders themselves are not offered). A new flow — and every
existing flow (migration `0019`) — starts with the companies' **accountant** (a link whose
role or title says accountant / бухгалтер, the providing company's first): today that is
Elmurat. *Nobody named* is allowed: then the wording is generic ("Ask the accountant for …",
"Здравствуйте! Пришлите, пожалуйста, …"). A founder can also **change it for one ask round**
(this month only, e.g. when the person is away): `/holding` → *Ask for акты* → *Who to ask
this month*. When someone is marked "I asked …", the акт remembers **who was asked**, so the
Monday reminder names that person even after the month changes. If a flow's person later
leaves, the flow shows a warning and nobody is named until a founder picks someone.

**The app never messages these people** (they are people records, not users; the outbox
refuses anyone who is not a founder). It pushes the **founders**, inside their **morning
summary** only — no separate push, so it uses no budget, can't be parked and follows quiet
hours and "not linked" holding like the summary itself:

- **Monthly**, from the day after the grace period (the **11th** by default): ONE grouped
  item per founder in ONE *Holding · акты* section with **at most one line per person**, e.g.
  "Ask Elmurat for 2 missing акты: Alura Style → Alura Brand (Sep, Oct)" and "Ask Edil for 1
  missing акт: Jobutify → Kiwi Go (Oct)". One button: **I asked Elmurat** (one person), *I
  asked the accountant* (nobody named) or *I asked them all* (several people) — a one-time
  server-side token, like task buttons. Both founders get it (holding matters are shared).
- **I asked …** (Telegram or the in-app buttons on `/holding`, one per person there) marks
  those months *requested* with today's date and the person asked, and **cancels the other
  founder's pending item** for the same months (it never reaches his summary; an
  already-shown button answers "Already done: Nuraaly marked these as asked on …").
- **Reminder:** акты requested ≥ 7 days ago and still not received appear in the next
  **Monday** summary ("Still waiting for 3 акты from Elmurat (asked 11 Nov): …", button *I
  asked again*). At most weekly per founder (one item per Monday). When the same person also
  has missing акты, it is still ONE line: "Ask Elmurat for 1 missing акт: …; still waiting
  for 2 акты (asked 11 Nov): …".
- Each item is shown once (`holding_ask_items`, unique per founder + kind + month/week, so a
  tick every 5 minutes changes nothing). **Nothing piles up** when a summary is not delivered
  (Telegram not linked yet, failed sends, quiet hours): a new round cancels the founder's
  older pending item of the same kind (`superseded`; the new one already covers every open
  month), and the summary shows at most one ask item and one reminder item (one line per
  person). Planned in `planHoldingAsks` (called by `planTick`), rendered by
  `holdingSummarySection` (called by the dispatcher for the morning summary). Per-round
  overrides live in `holding_ask_overrides` (round = YYYY-MM; row-level security on).
- `/holding` shows the same, one block per person, each with a **ready message in Russian**
  and a Copy button ("Элмурат, пришлите, пожалуйста, акты приёма-передачи за: …"; nobody
  named: "Здравствуйте! Пришлите, пожалуйста, акты приёма-передачи за: …"). The founder
  sends it himself; the app never does. The Russian name is the person's *short name* in
  People when it is written in Cyrillic, otherwise the first name spelled in Cyrillic
  ("Elmurat" → "Элмурат"); set a short name to change the spelling.

## AI roles

`/ai-roles` (sidebar → AI roles), the **AI roles** tab of each company and the right-hand
**agent panel**. Founders only (`assertAiRolesAccess` in `access.ts`); logic in
`src/server/services/ai-roles.ts`, pure rules in `src/server/ai/` and `src/lib/ai-roles.ts`.

**Hiring.** The catalogue lives in code (`ROLE_TEMPLATES` in `src/lib/ai-roles.ts`, copied to
`ai_role_templates` by `db:seed`): responsibilities, the numbers it needs **per company type**
(Kiwi Go = delivery: revenue, orders, COD collected, COD paid out; Alura Style = garment
factory: output, piecework pay total, defect rate; …), optional uploads, default schedule and
report sections. **Financial Analyst** can be hired; HR, Marketing and Operations are shown as
*Coming soon*. *Hire* opens a wizard: company → which numbers it waits for → schedule (monthly
on day 1–28, default the **10th**) and thresholds (warn ±20 %, risk ±50 % by default) → who
gets reports and whom it asks (both founders by default; founders only) → Hire. *Tune*,
*Pause/Resume* and *Run now (last month)* are on each hired role. One hire per role and
company (`ai_role_hires`).

**What it does each month** (`ai_role_runs`, one per hire and month):
`waiting_for_data → ready → analysed → reported` (or `failed`). A failed run is retried by
the tick with a backoff — after 1 h, 6 h, then every 24 h (`attempts`, `next_attempt_at`) — and
after 5 failures it stops and the report page shows **Failed — Retry** (the founder's Retry runs
it at once). A failure while re-analysing a run that already has a report keeps that report
(status stays `reported`, the page says "Update failed").

1. On its schedule day the scheduler tick creates the run for the month that just finished and
   checks the required numbers (C4 rules: monthly numbers need that month's value; daily
   numbers need **every day** of the month, then sum / average / last by the number's
   aggregation; weekly numbers belong to the month of their Monday).
2. Missing → `waiting_for_data` and a **data request** for each founder it asks: ONE line in
   the morning summary, e.g. "Financial Analyst needs October 2026 numbers for Kiwi Go:
   Revenue, COD collected +2 more — enter them: …/companies/kiwi-go?tab=numbers&g=day".
   When a number the role needs comes from a data source that is not connected yet (e.g.
   Kiwi Go orders from Edil's APIs), the line says "enter by hand or upload until the data
   source is connected" instead, and that number is left out of the Monday "N numbers wait
   for data sources" line while the request is open.
   Anti-spam: at most one line per role per founder per day, every day for 7 days, then
   **weekly**; at most 3 role lines per summary; a new month **supersedes** the older request
   (one line covers "September and October 2026"); pausing or no longer asking a founder closes
   theirs, and resuming / asking them again revives the same request with its original cadence
   (no new 7 days of daily chasing). No separate pushes — so no budget use, and quiet hours / "not linked" work like the
   summary itself.
   **Monthly totals for daily numbers** (Tune → *Data it needs* → *Accept monthly totals for
   daily numbers*, per hire; **on by default for a new Financial Analyst** (the founders'
   decision; migration 0016 switched it on for existing ones), off for other roles). Off: a
   daily number counts only with every day of the month. On: when its days are incomplete, the role uses a
   **month total** a founder entered for that number and month — an **average** for averaged
   numbers (on-time %), the **end-of-month value** for "last" numbers. Complete days always
   win; otherwise the month total; otherwise it is missing. Month totals are entered under the
   daily Numbers grid (*Month totals*, the last 3 finished months) or right in the report's
   "Waiting for these numbers" list ("October average [ ] Save", then the numbers are checked
   again). They are stored as metric values with `period_kind = month_total` on the 1st of the
   month (migration `0015`): latest wins per number + month with history kept, finished months
   and daily numbers only, never part of the daily series, cards, freshness or *Numbers
   waiting*, and a data source never writes or replaces them. The report's *Numbers used*
   marks such a value "(month total entered)" / "(month average entered)", the missing list
   says "21 of 31 days missing — or enter the month total", and the request line says
   "— enter the October total (or every day): …" ("total or average" when both kinds are
   missing; "… until the data source is connected" for connector numbers). Turning the switch
   on after a report shows *Settings changed* on it. A month total counts as "had data" (so
   a number without values reads "2+ months missing", not "never entered") only when the
   switch is on, like the values themselves.
3. Complete → the **rule-based analysis** (`src/server/ai/finance-rules.ts`, exact decimals,
   no AI): change vs the month before and vs the 3-month average beyond the thresholds; ratios
   when both numbers exist (COD paid out vs collected, revenue per order, piecework pay per
   piece per factory, returns rate, shipment error rate); numbers missing 2+ months; the
   Holding's intercompany debt growing 3 months in a row; missed targets. Each finding has a
   severity (risk / warning / info), the numbers and a plain-English sentence.
4. **One "report ready" push per founder who receives reports, per run** (outbox key
   `ai_report:<run>`, never twice — also not after *Run now* or *Run again*). It is a normal
   push: quiet hours, the daily budget (parked → listed in the next summary) and "not linked"
   apply, and one due just before the morning summary is folded into it (a line with the link).
5. The report page `/ai-roles/runs/<id>`: findings by severity, **Create task** on risk findings
   (a shared task for the company, only when a founder clicks; once per finding), the numbers
   used, and the AI summary box. A tick never changes a report already sent: if numbers are
   corrected later the page says *Numbers changed*; if the role was tuned since (numbers it waits
for, thresholds) it says *Settings changed* instead — two hashes per run (`inputs_hash`,
`settings_hash`). Either way **Run again** re-analyses (no new push).

**The orchestrator** (`src/server/ai/orchestrator.ts`) runs the roles on every tick and
composes the morning summary's requests so nothing is asked twice: a number an AI role is
asking for is removed from *Numbers waiting* for the months the role asks for (also on days the
role's line is parked until its next chase day) — a daily number late for this month's days
stays in *Numbers waiting* while the role asks for last month; numbers the Holding computes from акты (intercompany debt, any `derived`
number) are **never** on a role's line — not even after "I asked Elmurat", when the Holding has
nothing to ask that day (a hand-entered value would block the later derived update). The
Holding section asks for the акты and notes that the role waits for them too. Only the two founders
are ever asked or notified — people records (Elmurat, Edil) never.

**Without an AI provider (now).** Everything above works with `AI_PROVIDER` empty or `none`
(the only value implemented): the analysis is deterministic; the run records
`narrative_skipped` and the report shows "AI summary appears after the AI provider is chosen".
No LLM SDK, key or network call exists in the app.

**Plugging in a provider later** (after the founders choose one): implement `LlmProvider`
(`generate({ system, messages, tools?, maxTokens }) → { text, toolCalls?, usage }`) in its own
file, register it in `PROVIDER_FACTORIES` in `src/server/ai/provider.ts`, set `AI_PROVIDER` to
its id and its key in the hosting dashboard. Callers don't change. The narrative prompt
(`src/server/ai/narrative.ts`) is built **only from findings**; salary data can't enter it
(strict schema + `assertNoSalaryData`, tested). Findings about a pay-named number (salary,
payroll, wages, зарплата, ФОТ, оплата труда, оклад — by label, sentence or metric key) are left
out of the prompt and the report says so; if the check still refuses the prompt nothing is sent
and the run records `narrative_skipped:salary` — the report itself never fails because of it.
Only the factory's piecework pay **total** (`piecework_total`) is allowed, by explicit key.
Without a provider no prompt is built at all.

### Tuning roles (AI role editor)

"Tune AI inside the cockpit" — founders only, on `/ai-roles`. Logic in
`src/server/services/ai-role-editor.ts` (editing, custom roles, versions) and
`src/server/services/ai-role-defs.ts` (a role as tuned: code catalogue + edits); the check
catalogue and schemas are pure (`src/lib/ai-role-config.ts`). Tables (migration
`0021_ai_role_editor.sql`, additive, RLS + revoke): `ai_role_configs` (role-level settings,
one row per edited built-in role or custom role) and `ai_role_settings_log` (every version).

- **Edit role** (on each role card, template level) and **Edit settings** (on each hire, its
  own overrides): name, job description, responsibilities (one per line), **your
  instructions** (free text, stored now and used by the AI summary only after the AI provider
  is chosen — the rule checks never depend on it; it goes through the same no-salary check as
  the prompt, so instructions naming salaries mean no AI summary), schedule (**monthly** on a
  day, **weekly** on a weekday — for report roles the first such weekday of the month, for the
  Org Expert its line's weekday —, or **off**: Run now only / no line), recipients (founders
  only), and **every rule check on/off with its own thresholds**:
  - Financial Analyst: change vs the month before (warn / risk %, = the hire's Tune
    thresholds), change vs the 3-month average (own warn / risk %, empty = same as the month
    before), ratios, COD paid out vs collected (warn below / risk below %, empty = 100 − the
    warn / risk %), defect-rate ceiling (off by default, max %), intercompany debt growing N
    months in a row (2–6, default 3), target missed, missing numbers.
  - Org Structure Expert: each check on/off, the head limit (more than N departments) and the
    overdue-tasks threshold (default 5).
  - **Defaults = the behaviour before the editor** (tested: identical findings and unchanged
    report hashes). A hire without its own checks follows the role's; *Use the role's checks*
    clears a hire's override; empty name / description fields use the role's text. The
    "vs the month before" thresholds have always been per hire (Tune): on the role they are
    the starting values of new hires. Changing what the analysis uses (checks, thresholds,
    numbers watched) marks existing reports **Settings changed** (Run again re-analyses, no new
    push); renaming or new instructions do not.
- **Create your own role** (section *Your roles*): from scratch or as a **copy** of a built-in
  role that analyses numbers (Financial Analyst; HR / Marketing / Operations too). A custom
  role picks **one company**, the **numbers it watches** (from that company's metrics; each
  can be "waits for it"), and generic checks: change vs the month before, vs the 3-month
  average, missing numbers, target missed, and **ratio checks** between two watched numbers
  with a min and / or max (plain or as %). *Hire for <company>* hires it like a built-in; it
  runs through the same run → report → "report ready" push pipeline and the same anti-spam
  rules (one grouped data-request line per role per founder per day, daily for 7 days then
  weekly; "never entered" / data-source lines stay Monday-only in *Numbers waiting*).
- **Salary guard.** A custom role can never watch pay data: a number whose key, name or
  aliases name salaries / payroll / wages / bonuses / compensation / зарплата / з/п / зар. плата
  / ФОТ / оклад / премия / бонус (the narrative's word list; keys checked as snake_case and
  camelCase parts, e.g. `fot_total`, `fotTotal`), **or that is flagged
  `metric_definitions.is_pay_data`** (0024; existing pay-named numbers were flagged), is refused
  when the role is saved (shown as "pay data — never watched") and dropped again at run time (a
  forged config analyses nothing of it); findings about such numbers never enter an AI prompt.
  Only `piecework_total` (a factory total) is allowed, by key, unless it is flagged.
- **Versions.** Every save is a numbered version per role / per hire (who, when, before,
  after; creating a role or a hire is version 1). *History → Revert to this* restores that
  version's settings and is logged as a new version. **Reset to defaults** (in the editor)
  takes a built-in role back to the code's defaults, a custom role to its first version, a hire
  to its role's defaults (own checks / name cleared, notes kept) — logged as a version
  ("reset to defaults") that can be reverted. Nothing is deleted. Hire edits are made under a
  row lock, so two edits at once both land and log the right "before".

## Org structure (Vysotsky model)

`/org` (sidebar → Org structure; company switcher, Kiwi Go first) and each company's **Org
structure** tab. Logic in `src/server/services/org.ts`, pure rules / templates in `src/lib/org.ts`.

- **Model.** One chart per company, optionally per company unit (Alura Style ХБК / Ош Район get
  their own chart via *Chart for:*). Tables (migration `0017_org_structure.sql`, RLS + revoke):
  `org_charts`, `org_divisions` (1–7, shown 7, 1, 2 … 6; name, Руководитель title,
  Подчинение, ЦКП, head person), `org_departments` (number, name, ЦКП, Статистика, optional
  linked company number, head person, order), `org_functions` (text, responsible person,
  order), `org_change_log` (who / when / before / after). Nothing is deleted: departments and
  functions are **archived** (*Show archived* → *Restore*, back where they were).
  Migration `0020_org_integrity.sql` (additive) lets the database itself keep every division /
  department / function / log row inside its chart and company (composite foreign keys) and
  allows a department number only once among a chart's **live** departments (partial unique
  index; old duplicates, if any, were renumbered to the next free number and logged). A new
  department gets the next number (22, 23, …; past 99 the lowest free one; none left →
  refused); renumbering, restoring or undoing onto a number in use is refused with the
  department that holds it.
- **Kiwi Go** is seeded from the old cockpit (divisions 7, 1, 2, 3 complete; division 4
  "Операции" with the visible department names marked "(уточнить)"; 5 and 6 template names,
  departments 13–18 empty). `db:seed` creates it only when Kiwi Go has no chart, so edits are
  never overwritten. Other companies: **Apply Vysotsky template** (7/21, standard Russian
  names marked "default name" until renamed).
- **Editing (founders).** *Edit mode* (also opened by *+ Функция* / *+ Отдел*, shown in view
  mode too): click any text to edit it in place (saved on blur), drag ⠿ with the mouse to move
  functions within / between departments and departments within / between divisions
  (dnd-kit), or use ⋯ → Move up / down / *Move to department* / *Move to division* / Archive —
  **the ⋯ menu is the keyboard and phone path** (dnd-kit's keyboard drag — focus ⠿, Space,
  arrows, Space — also works, but between cards of very different heights it can pick an
  unexpected neighbour). Every change carries the chart version the board shows; if the chart
  changed meanwhile (the other founder, another tab) the change is refused, the board
  refreshes and says so — nothing is applied from a stale copy.
  Click a department (or ⓘ) for the right-hand panel: head (people of **that** company
  only), ЦКП, statistic, linked number with its latest value and freshness, functions with
  responsible people, open / overdue tasks of the department. Division ⓘ: head person,
  Руководитель, Подчинение, ЦКП. Phone: one division at a time (tabs), text and people
  editing; dragging only on a laptop.
- **Undo / history.** Every change is one logged transaction (the chart row is locked; order
  rewritten 0, 1, 2 …). *Undo* takes back the newest change not yet undone, one at a time,
  among the last 20 changes (undos are logged too). *History* lists the last 20 entries.
- **Isolation.** Moves stay inside one chart; a department / division / person / number of
  another company is "not found" or refused, also with forged ids.
- **People on the board.** View mode reads like an org chart: a division shows
  "Руководитель: Генеральный директор — Нуралы" (post title and the head's name), a department
  its head's name, each function the responsible person's initials in a small circle (full
  name on hover / keyboard focus). Empty places show **+ назначить** (founders) — a small
  picker of the company's people. Every person picker (that popover, the department and
  division panels, each function in the panel) has **+ New person**: full name, short name,
  phone, Telegram, role / title (default: the department's / function's name, editable) →
  the person is created on People, linked to this company (and the chart's unit, if any) and
  assigned, in one transaction and one change-log line. Founders only. *Undo* takes back the
  assignment; the person and their company link stay (people are never deleted).
- **Org positions on People.** The person page has an *Org positions* section (company · unit ·
  division · department · function, head of division / department or function), and the
  People list and a company's People tab show them under the roles.
- **Tasks.** Company tasks have an optional *Department (org chart)* picker
  (`tasks.org_department_id`, must be of the task's company; changing the company clears it).
  A task whose department was archived keeps it: the form lists it as "… (archived)", so
  editing the task does not drop the link. Task rows show their department.
- **Org Structure Expert** (AI roles, rule-based, no AI provider): divisions / departments
  without a head, one person heading more than N departments (default 4, tunable; counted on
  real people — a head who left the company or whose link to it ended counts as no head; the
  strip is recomputed on every board load, so it follows each assignment at once), no ЦКП,
  no statistic, linked number not up to date, 5+ overdue tasks, functions without a
  responsible person (info). Shown as a strip above every board and as a section on
  `/ai-roles`. Hire it per company (*Hire Org Structure Expert*: company → limit → who gets
  it): no monthly runs, no pushes; on **Mondays** its recipients get **one** grouped line in
  the morning summary (all hired companies, warnings only, stale numbers left to *Numbers
  waiting*), computed when the summary is built so nothing piles up. Brainstorming / advice
  waits for the AI provider.

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
  Salary changes from a non-viewer get 403 and nothing is changed. The whole request is one
  transaction: if any part fails (unknown link, conflict, validation), nothing is changed.
  Two salaries for the same role and date in one request are refused (400).

- `GET /api/v1/companies/:slug/metrics` (definitions with latest value, change, freshness and the last 12 periods)
- `GET /api/v1/metrics/:id/values?history=1&limit=` (current value per period; with `history=1` also corrected rows)
- `POST /api/v1/metrics/:id/values` `{ "period": "2026-10" | "2026-10-31", "value": 123, "note"? }` (201 new, 200 correction/unchanged)

- `GET /api/v1/holding/acts` (grid: months, rows with cells, missing / requested counts, `ask` with the copyable message)
- `PATCH /api/v1/holding/acts` `{ flowId, period: "2026-10", status?, amount?, actNumber?, actDate?, requestedOn?, note?, attachmentFileId? }` (left-out fields stay, `null` clears)
- `POST /api/v1/holding/asked` `{ cells: [{ flowId, period }], again? }` ("I asked …")
- `POST /api/v1/holding/ask-person` `{ flowId, personId }` (who to ask for this month's round; `personId: null` = back to the flow's person)
- `GET | POST /api/v1/holding/flows` (POST takes `askPersonId?`: left out = the accountant, `null` = nobody named), `GET | POST /api/v1/holding/contracts`, `PATCH /api/v1/holding/contracts/:id` (fields or `{ "archived": true }`)
- `GET /api/v1/holding/debts?asOf=` (pairs, total, ledger entries), `POST /api/v1/holding/debts` `{ kind: "payment" | "opening", debtorCompanyId, creditorCompanyId, entryDate, amount, note? }`
- `POST /api/v1/holding/files` (multipart `file`) → `{ id }`; `GET /api/v1/holding/files/:id`

- `GET /api/v1/ai/roles?companyId=` (role catalogue, hires, provider status), `POST /api/v1/ai/roles` `{ templateKey, companyId, settings?, notes? }` (hire, 201; 409 when already hired)
- `GET /api/v1/ai/hires/:id` (hire + recent runs), `PATCH /api/v1/ai/hires/:id` `{ settings?: { schedule, thresholds, requiredMetricKeys, recipients, askUserIds }, notes?, status?: "active" | "paused" }`
- `GET /api/v1/ai/runs/:id` (status, missing numbers, findings, numbers used, narrative status)

Input shapes are the Zod schemas in `src/lib/schemas.ts`, `src/lib/people-schemas.ts`, `src/lib/metric-schemas.ts`, `src/lib/holding-schemas.ts` and `src/lib/ai-roles.ts`.

## Browser extension

The founders' Chrome extension reads numbers from web pages (seller cabinets, dashboards) and
sends them here. Founders only. Logic in `src/server/services/extension.ts` and
`src/server/http/ingest.ts`; tables `extension_keys` and `extension_ingest_log` (migration
`0022_extension_ingest.sql`, additive, RLS + revoke; it also adds the number source
`extension`) and `ingest_rate_counters` (0023, RLS + revoke).

**Create a key.** *Settings → Browser extension* → name it ("Laptop Chrome") → **Create key**.
The key (`fcx_…`) is shown **once** — copy it into the extension's settings. Only its SHA-256
is stored, with the name, when it was created and last used. Each founder sees and revokes only
their own keys (at most 10 active); **Revoke** stops it at once. A key acts as its owner. The
same card lists the latest calls of both founders' keys (key, adapter, accepted / rejected,
the first reasons).

**API contract** (given to the extension's developer):

```
POST /api/v1/ingest
Authorization: Bearer fcx_…
Content-Type: application/json

{ "source": "extension",
  "adapterId": "wb-seller",                      // letters, digits . _ : -  (≤ 64)
  "points": [                                    // at most 500; body at most 256 KB
    { "companySlug": "kiwi-go", "metricKey": "revenue", "periodStart": "2026-10-01", "value": "1234567.89" },
    { "companySlug": "alura-style", "metricKey": "output_pcs", "unitSlug": "hbk", "periodStart": "2026-10-30", "value": "800" }
  ] }

200 { "accepted": 1, "rejected": [{ "index": 1, "reason": "This month isn't finished yet" }] }
```

- Each point is accepted or rejected **on its own**, with a reason; the rest is written. Every
  point goes through the same write path as typed / uploaded / connector numbers (C4 rules):
  - `periodStart` is `YYYY-MM-DD` and must be the **first day of the number's period** (the day,
    the Monday of a week, the 1st of a month); no future periods; weekly / monthly numbers only
    for a **finished** week / month.
  - `value` is a **string** with an exact decimal ("1234567.89", "1 250", "95.5%" for %
    numbers); ambiguous text ("85.000") is refused like everywhere.
  - Company isolation: only companies the key's owner can access; anything else is "Unknown
    company". A number tracked per factory needs `unitSlug` (e.g. `hbk`, `osh-rayon`).
    Numbers the Holding computes from акты (intercompany debt) are refused.
  - A number a founder **typed or uploaded is never replaced**: a different value is rejected
    ("A founder entered 100 for this period — kept") and recorded, so the card shows "Source
    disagrees: Browser extension (wb-seller) says …" until the values agree; the same value is
    accepted (nothing written). Among automatic values (extension, data sources) the **latest
    wins**, with history kept. The card says "via the browser extension".
  - Two points for the same number and period in one request are both rejected.
- Errors: 401 missing / malformed / wrong / revoked key; 403 a web page origin (or an
  extension ID not on `EXTENSION_ALLOWED_IDS`); 415 not JSON; 400 bad JSON or envelope
  (`source`, `adapterId`, more than 500 points); 413 over 256 KB; **429** over 60 requests per
  key per minute, or over 20 failed key checks per IP per minute (`Retry-After`: seconds until
  the minute ends). Error bodies are `{ "error": { "code", "message" } }`.
- **Limits** are fixed one-minute windows counted atomically in `ingest_rate_counters`
  (migration 0023) **before** a request is processed, so parallel requests can't slip past;
  refused and failing calls count too. A header that can't be a key (`Bearer fcx_` + 43
  characters) is refused without a database query; an IP over the failed-check limit is refused
  before the key lookup for the rest of the minute.
- **CORS:** this route only, for `chrome-extension://…` origins (preflight answered:
  `POST, OPTIONS`, headers `Authorization, Content-Type`). Optional `EXTENSION_ALLOWED_IDS`
  (comma-separated extension IDs, see `.env.example`): when set, only those IDs; empty = any
  extension (development). Other web origins get 403; calls without an `Origin` (scripts, curl)
  are fine. Exactly `/api/v1/ingest` (nothing below it) is exempt from the session cookie and
  the same-origin guard (`src/middleware.ts`) because the bearer key is the proof.
- Each authenticated call is logged (`extension_ingest_log`: key, owner, adapter, counts, the
  first 50 rejections); rate-limited calls are not. Deleting a key (or its founder) keeps the
  log rows ("Deleted key", 0026). Each call that writes, conflicts with or agrees with a
  founder's number creates a connector-like run per company (`connector_runs`,
  `extension:<adapterId>`); a call that changes nothing leaves none. "Source disagrees" is
  decided per number and period by the newest run that mentions it, so later calls about other
  numbers never hide it.

## Connect to Claude

The **Founder Cockpit connector** lets either founder say in any Claude chat “save this plan to
the Founder Cockpit for Kiwi Go” — Claude then creates the project and its tasks here, assigned
to founders or staff, and the Cockpit chases them like any other task (morning summary,
Telegram reminders, staff pushes). It is a remote MCP server at `/api/mcp` with OAuth sign-in;
nothing to install and no key to copy.

### Connect it (once per founder, about a minute)

1. Open **claude.ai** (web or desktop app) and sign in to your Claude account.
2. Click your name (bottom left) → **Settings** → **Connectors**.
3. Scroll down and click **Add custom connector**.
4. Name: `Founder Cockpit`. Remote MCP server URL:
   `https://founders-app-one.vercel.app/api/mcp` — leave *Advanced settings* (client ID /
   secret) empty. Click **Add**.
5. Click **Connect** next to *Founder Cockpit*. A Founder Cockpit tab opens: sign in if asked
   (your normal Cockpit email and password), read the consent screen (“Allow Claude to read and
   create projects and tasks in Founder Cockpit?”) and click **Allow**. The tab closes and the
   connector shows as connected.
6. In a chat, make sure the connector is switched on (the **tools / “Search and tools”** button
   under the message box → *Founder Cockpit* on). Then ask, for example:
   - “Save this plan to the Founder Cockpit for Kiwi Go, project *Osh launch*, due 15 December:
     Aibek hires 5 couriers by 20 Nov, Talant does the price list, I call the bank.”
   - “What's overdue at Kiwi Go?” · “Mark ‘Call the bank’ done” · “Add a comment to …”

Claude asks before it changes anything (you can choose *Always allow* per tool). If a name
fits several people or companies (“Aibek” at Kiwi Go), nothing is saved and Claude asks you
which one. Claude for Team / Enterprise: an owner adds the custom connector once under
*Organization settings → Connectors*, then each founder clicks **Connect** and signs in.

**What it can do** (tools): `list_companies`, `list_people(company)`, `list_projects(company?)`,
`get_project(project)`, `list_tasks(company?, project?, assignee?, status?, overdue?)`,
`create_project(company, name, description?, start_date?, due_date?, tasks[])` (all or nothing),
`add_tasks(project, tasks[])`, `update_task(id, …)`, `complete_task(id)`,
`add_task_comment(id, text)`. Each task: `title`, `assignee` (a founder, `me`, or a person who
works at that company), `due_date`, `priority`, `notes`, `private`.

**Rules.** The connector acts as the founder who clicked Allow, through the same services and
access rules as the app: shared tasks are company tasks both founders see, a `private` task is
a personal todo only you see (and can only be yours), staff can only get tasks of a company they
work for. It cannot see salaries, the holding or numbers, and cannot delete anything. Only
founders can connect (a staff login gets “Only the founders can connect apps”).

**Disconnect**: Settings → **Connected apps · Claude** → *Disconnect* (takes effect at once), or
remove the connector in Claude.

### How it works (for developers)

- `POST /api/mcp` — MCP **Streamable HTTP** transport from `@modelcontextprotocol/sdk` (pinned
  1.32.2, `WebStandardStreamableHTTPServerTransport`), stateless, JSON responses; GET → 405.
  `src/server/http/mcp.ts`, tools in `src/server/mcp/tools.ts`, name resolution in
  `src/server/mcp/resolve.ts`.
- OAuth 2.1 (`src/server/services/oauth.ts`, `src/server/http/oauth.ts`): dynamic client
  registration `POST /api/oauth/register` (RFC 7591; 10 per IP per minute), consent page
  `GET /oauth/authorize` (signed-in founder) → `POST /api/oauth/authorize` (same-origin + HMAC
  consent token), `POST /api/oauth/token` (authorization_code with **PKCE S256 only**,
  refresh_token), `POST /api/oauth/revoke` (RFC 7009). Metadata:
  `/.well-known/oauth-authorization-server` (RFC 8414) and
  `/.well-known/oauth-protected-resource` (RFC 9728, also at `…/api/mcp`); a 401 from
  `/api/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…"`.
- Tokens are opaque random strings, stored only as SHA-256: access 1 hour, refresh 30 days,
  rotated on every refresh (re-using an old refresh token revokes the whole connection), codes
  10 minutes and one-time. Tables `oauth_clients`, `oauth_auth_codes`, `oauth_tokens`
  (migration `0030_oauth_connector.sql`, RLS + revoke).
- Issuer / resource URL: `APP_URL` when set, else the address the request came to. Set
  `APP_URL=https://founders-app-one.vercel.app` on Vercel so preview URLs never become the issuer.
  An access token issued for a resource (RFC 8707 `resource`) only works at that resource: a token
  minted for another deployment's `/api/mcp` is refused (trailing slash ignored).
- **Redirect allowlist.** Registration accepts only `redirect_uris` on **`claude.ai`** or
  **`claude.com`** (https, exact host), a loopback address (`localhost` / `127.0.0.1` / `[::1]`,
  http allowed only there — MCP Inspector, local tools) or a host listed in
  **`OAUTH_EXTRA_REDIRECT_HOSTS`** (comma-separated, e.g. `OAUTH_EXTRA_REDIRECT_HOSTS=tools.example.com`;
  https only). Anything else is `invalid_redirect_uri`, so anyone registering a client cannot make
  `/oauth/authorize` an open redirect. The authorize step re-checks: a client whose redirect is
  unknown, does not match, or is not (or no longer) allowed gets an error page and is never
  redirected; only after that do request errors go back to the client as `error=` redirects.
- Middleware: only `/api/mcp`, `/api/oauth/register`, `/api/oauth/token`, `/api/oauth/revoke`
  (exact paths) and `/.well-known/*` skip the session check; `/oauth/authorize` and
  `/api/oauth/authorize` need the founder's session.
- Try it locally with the MCP Inspector: `npx @modelcontextprotocol/inspector`, transport
  *Streamable HTTP*, URL `http://localhost:3000/api/mcp`, then *Open Auth Settings → Quick OAuth
  Flow*.

## Folder map

```
src/
  app/
    login/                 Sign-in page + server action
    oauth/authorize/       Claude connector consent screen (OAuth)
    .well-known/           OAuth metadata (authorization server, protected resource)
    (app)/                 Signed-in app (shell layout)
      page.tsx             Today
      tasks/               Tasks (views, filters, inline edit)
      companies/[slug]/    Company page with tabs (Overview KPI cards, Numbers grid); numbers/import upload
      projects/[id]/       Project with tasks and progress
      people/              People list, person page, new person, import wizard (+ server actions)
      holding/             Holding: акты grid + cell panel, Ask for акты (per person), debts, договоры, flows (+ server actions)
      ai-roles/            AI roles: catalogue, Hire/Tune wizard, role editor (Edit role / Edit settings / Create your own role), hired roles; runs/[id] report page (+ server actions)
      org/                 Org structure board (+ server actions); components/org/ holds the board, panels, expert strip
      search/ more/
      settings/            Own notification preferences + Telegram link; Access (salary viewers);
                           founders: Connect Telegram, Start reminder clock (services/app-setup.ts)
      dev/notifications/   Dev inbox (dev tools only)
      actions.ts           Server actions (call the service layer)
    api/v1/                REST API (thin, calls the service layer); api/v1/ingest: the browser extension (Bearer key)
    api/mcp/               Founder Cockpit MCP server for Claude (OAuth bearer token)
    api/oauth/             OAuth: register, token, revoke (public), authorize (consent POST, session)
    api/telegram/webhook/  Telegram webhook (secret header)
    api/cron/tick/         Scheduler tick (CRON_SECRET)
  components/              UI: shell (sidebar, top bar, tabs), tasks, projects, people, settings
  lib/                     Pure code: dates.ts (timezone), schemas.ts + people-schemas.ts + metric-schemas.ts (Zod),
                           kpis.ts (default metrics), metrics.ts (periods, freshness, change), money.ts,
                           holding.ts + holding-schemas.ts (акты, debts, contracts rules)
  server/
    auth/                  AuthProvider: local (now) and supabase (stub), session cookie, login rate limit
    db/                    schema.ts, connect.ts (PGlite or Postgres; pooler-safe options), migrate.ts, seed.ts,
                           seed-deploy.ts (first-deploy seed)
    app-url.ts             The site's address (APP_URL, else Vercel's)
    services/              Business logic + access rules (tasks, projects, companies, people, salaries,
                           people-import, metrics, metrics-import, connectors, search, notifications,
                           holding, holding-asks, holding-files, ai-roles, ai-role-defs, ai-role-editor, org, org-expert,
                           extension, staff (Team on Telegram), staff-tasks (what a person may do), task-comments, routines,
                           oauth (Claude connector: clients, codes, tokens, connected apps))
    ai/                    AI roles: provider.ts (LlmProvider, NoneProvider), finance-rules.ts, month-values.ts,
                           narrative.ts (prompt builder, no salaries), orchestrator.ts (tick + morning-summary dedupe)
    storage/               FileStorage for documents: local .data/uploads, Supabase placeholder
    import/parse-table.ts  .xlsx/.csv parsing for the people and numbers imports (in memory, 2 MB limit)
    connectors/            Data sources: Connector interface, registry, stubs (no network), runner
    notifications/         Channels (Telegram, dev, push stub), outbox, planner, dispatcher, bot, staff-dispatcher,
                           messages-ru.ts (staff texts), staff-notify.ts (lines/pushes to founders about staff),
                           telegram-setup.ts (setWebhook / setMyCommands), reminder-clock.ts (pg_cron + Vault),
                           routine-planner.ts (routines: open runs, ask, remind, escalate, close)
    http/request-guard.ts  Same-origin + JSON check for mutating /api/v1 calls
    http/ingest.ts         POST /api/v1/ingest: key auth, CORS for chrome-extension://, limits, log
    http/oauth.ts, mcp.ts  Claude connector: OAuth endpoints and the /api/mcp handler
    mcp/                   MCP tools (tools.ts) and name → id resolution (resolve.ts)
  middleware.ts            Redirects signed-out users to /login (401 JSON for /api), CSRF guard
drizzle/                   SQL migrations (generated by drizzle-kit)
scripts/                   db:migrate(:deploy) / db:seed(:deploy) / db:reset / cron:tick / telegram:poll
vercel.json                Vercel build command (npm run vercel-build); no crons (Hobby: daily only)
supabase/policies.sql      RLS policies for a future direct-client mode (applied by hand)
tests/                     Vitest unit + service tests
e2e/                       Playwright smoke test + screenshots
docs/screenshots/          UI screenshots (ai-role-editor.png, ai-custom-role-report.png, extension-keys.png, org-desktop.png, org-edit-mode.png, org-phone.png, ai-roles-hire-wizard.png, ai-report.png, holding-desktop.png, holding-act-panel.png, holding-ask-card.png, numbers-grid.png, people-list-salaries.png, …)
docs/samples/              people-sample.csv, kiwi-go-numbers-sample.csv (fake data) for the importers
docs/reviews/              Independent reviews and how each finding was resolved
```
