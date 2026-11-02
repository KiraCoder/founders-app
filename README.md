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
| `npm run db:seed` | Load founders, companies, people and `[sample]` tasks (safe to re-run) |
| `npm run db:reset` | **Local only.** Wipe + migrate + seed. Refuses to run against a non-localhost database |

Screenshots: `SCREENSHOTS=1 npx playwright test screenshots` (writes `docs/screenshots/`).

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
   (The seed refuses to use the default dev password on a real database.)
4. **Create the website.** Sign in at vercel.com with GitHub → *Add New → Project* → pick this repository.
5. **Add environment variables** in Vercel → *Settings → Environment Variables*:
   - `DATABASE_URL` = the Supabase connection string from step 2
   - `SESSION_SECRET` = a long random text (on a Mac/Linux: `openssl rand -base64 48`)
   - `AUTH_MODE` = `local`
   - `APP_TIMEZONE` = `Asia/Bishkek`
6. **Deploy.** Vercel builds automatically on every push. The app refuses to start without
   `SESSION_SECRET`, which protects you from an insecure setup.
7. **Later (developer task):** switch to Supabase Auth (`AUTH_MODE=supabase`, see
   `src/server/auth/supabase.ts`) and review/apply the draft row-level security in
   `supabase/policies.sql`.

## How access works

- Every page, server action and API route goes through the service layer in `src/server/services/`.
  Access rules live in one place: `src/server/services/access.ts`.
- A **personal todo** (`visibility = private`) is visible only to the founder who created it.
  It can't be assigned to anyone else. Shared tasks need a company and are visible to both founders.
- Company isolation: a task's project must belong to the same company, and a person can only be assigned
  to a task if they work for that company (`person_companies`).
- **Overdue** = not done/cancelled and due date before *today in Asia/Bishkek*. It stays overdue until
  someone moves the deadline or closes the task. Every deadline change is written to `task_events`.
- Salaries are deliberately **not** in `person_companies`; they will get their own restricted table.

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
      actions.ts           Server actions (call the service layer)
    api/v1/                REST API (thin, calls the service layer)
  components/              UI: shell (sidebar, top bar, tabs), tasks, projects
  lib/                     Pure code: dates.ts (timezone), schemas.ts (Zod), kpis.ts
  server/
    auth/                  AuthProvider: local (now) and supabase (stub), session cookie
    db/                    schema.ts, connect.ts (PGlite or Postgres), migrate.ts, seed.ts
    services/              Business logic + access rules (tasks, projects, companies, people, search)
  middleware.ts            Redirects signed-out users to /login (401 JSON for /api)
drizzle/                   SQL migrations (generated by drizzle-kit)
scripts/                   db:migrate / db:seed / db:reset
supabase/policies.sql      Draft RLS policies (not applied locally)
tests/                     Vitest unit + service tests
e2e/                       Playwright smoke test + screenshots
docs/screenshots/          UI screenshots
```
