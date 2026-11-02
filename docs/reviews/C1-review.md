# C1 Foundation review (independent reviewer, commits 5034936..d995fd0)

Verified OK: all pages/actions/API derive user from session; all task reads/writes through visibleTasksWhere (getTask, loadRawVisibleTask, listTaskEvents, search, Today, taskCountsByCompany, project progress); no IDOR found; company isolation; overdue in Bishkek tz; task_events logging; session security (JWT+DB row, httpOnly, SameSite=Lax, Secure in prod, prod refuses without SESSION_SECRET, bcrypt dummy compare); Zod strict; no stack leaks. Lint/typecheck/build/43 tests pass.

## Must fix
1. HIGH — Supabase deploy leaves all public tables without RLS. drizzle/0000_init.sql never enables RLS; Supabase Data API grants anon/authenticated on public by default → anon key holder could read users.password_hash, sessions, private todos. Fix: migration enabling RLS (deny-all) on every table (app connects as owner, bypasses RLS) and/or revoke anon/authenticated grants on public. Must be harmless on PGlite/local Postgres (roles anon/authenticated may not exist → guard with DO block checking pg_roles).
2. MEDIUM — seed guard bypass: scripts/db-seed.ts:65 only checks DEV_FOUNDER_PASSWORD is set; .env.example:17 sets it to founders-dev-2026; scripts/env.ts loads .env too. Fix: refuse on remote DB when value equals DEV_PASSWORD_DEFAULT or < 12 chars; blank it in .env.example.
3. MEDIUM — supabase/policies.sql inconsistent: line 44 column-level revoke of password_hash ineffective while table SELECT granted (use revoke table select + grant other columns, or a view); lines 72–78 tasks_update WITH CHECK lets non-owner set owner_user_id to self then make private (hijack); no enforcement of shared-needs-company / private-no-other-assignee; lines 88–90 task_events_insert allows events for invisible tasks.
4. MEDIUM — audit log can leak private todos: task_events rows for private tasks carry company_id + title in new/oldValue; after delete task_id nulls (ON DELETE SET NULL, 0000_init.sql:149) and snapshot keeps title/owner/visibility. Fix: add visibility + owner_user_id to task_events and visibleEventsWhere in access.ts (or null company_id on private-task events).
5. LOW–MEDIUM — open redirect: src/app/login/actions.ts:25 safeNext accepts "/\evil.com" (new URL resolves to https://evil.com/). Fix: reject backslash/control chars and require new URL(next, base).origin === base.origin.

## Can wait (but cheap — do them)
6. Invalid non-UUID ids in server actions → 500 (src/app/(app)/actions.ts:51-68; projects/[id]/page.tsx:20 loose regex). Fix: z.uuid() validation in loadRawVisibleTask and getProject → not_found.
7. Re-running seed on real DB overwrites founders' passwordHash (seed.ts:136-140) without revoking sessions; withSamples defaults true → [sample] tasks in prod. Fix: hash only on insert; samples off by default when driver is postgres (opt-in flag).
8. No login rate limiting — add a simple DB- or memory-based limiter per email+IP (e.g. 10 failures / 15 min) now; note distributed limiter for later.
9. REST API CSRF relies on SameSite=Lax only — add Origin check for mutating /api/v1 requests (allow same-origin; require JSON content-type).
10. listPeople without companyId (people.ts:179), assignablePeopleByCompany (people.ts:209), listCompanyCards project counts (companies.ts:111) bypass central access filters — route through access.ts helpers.
11. Test gaps: counts/project progress/company tab counts exclude other founder's private tasks; sign-out/expiry → getUser null; middleware 401/redirect; safeNext; seed guard; isRemoteDatabaseUrl; listTaskEvents after shared→private change.

## Resolution

All 11 findings were fixed on branch `claude/adoring-brown-rriwam` after C2. Verified with
`npm run lint`, `typecheck`, `test`, `build`, `test:e2e`, and by migrating a populated
Supabase-like Postgres 16 (roles `anon`/`authenticated` with Supabase's default grants)
from the pre-fix state.

1. **RLS (HIGH).** Migration `drizzle/0002_rls_lockdown.sql` enables RLS on every table in
   `public` (incl. all C2 notification tables) and revokes all table/sequence privileges and
   default privileges from `anon`/`authenticated`, inside a DO block that skips the revoke
   where those roles do not exist (PGlite, local Postgres). RLS is not forced, so the app
   (table owner) works unchanged. `0004` locks down its new table the same way.
   `tests/integration/rls.test.ts` asserts every public table has RLS after migrate (future
   tables cannot forget it) and simulates Supabase grants to prove the client roles end up
   with no access.
2. **Seed guard.** `planSeed` (`src/server/db/seed-config.ts`) refuses a Postgres database
   when `DEV_FOUNDER_PASSWORD` is missing, equals the dev default or is shorter than 12
   characters, checking the value actually loaded (also from `.env`). `.env.example` now
   leaves it blank. Tests in `tests/unit/seed-config.test.ts`.
3. **policies.sql.** Rewritten and marked as defense in depth for a future direct-client
   mode (the service layer remains the source of truth). Column-level `SELECT` grant on
   `users` without `password_hash` (no table-level grant); owner immutable and visibility
   changeable only by the owner (trigger, client roles only); `task_shape_ok` enforces
   shared-needs-company and private-has-no-other-assignee on insert/update; `task_events`
   readable by the task's rule, insertable only for visible tasks, append-only; server-only
   tables have no grants. Idempotent. `tests/integration/migrations.test.ts` applies it to a
   Supabase-like database and checks each rule as a signed-in client.
4. **Audit log leak.** `task_events` gained `visibility` and `owner_user_id`
   (`0003_task_events_visibility.sql`): backfilled from the live task, from the delete
   snapshot for deleted tasks, otherwise private to the actor. They follow the task when its
   visibility changes and are frozen after delete. `visibleEventsWhere` in `access.ts` is
   used by `listTaskEvents`. Tests in `tests/integration/audit-log.test.ts` (private,
   deleted, shared to private) and a backfill test on pre-0003 data.
5. **Open redirect.** `src/lib/safe-next.ts` rejects backslashes and control characters and
   requires the resolved URL to keep the same origin. Tests in `tests/unit/safe-next.test.ts`.
6. **Non-UUID ids.** `assertValidId` (Zod `z.uuid()`) in `getTask`, `loadRawVisibleTask`
   (update/delete) and `getProject` turns malformed ids into `not_found`; the loose regex on
   the project page was removed. Tested for tasks, events, projects and reminder snoozes.
7. **Re-seed overwrites passwords / samples in prod.** Existing founders keep their
   password hash; `SEED_RESET_PASSWORDS=1` re-hashes and deletes their sessions. Samples
   are opt-in on Postgres (`SEED_SAMPLES=1`), default on for the local embedded DB.
8. **Login rate limit.** DB-backed (`login_attempts`, migration 0004, hashes only): 10
   failures per email or 20 per IP in 15 minutes blocks sign-in without checking the
   password; success clears the email's failures; old rows pruned. Works on PGlite and
   Postgres and across serverless instances. Per-IP limit is 20 rather than 10 because both
   founders may share one office IP. Tests in `tests/integration/login-limiter.test.ts`.
9. **CSRF.** `src/server/http/request-guard.ts`, run by the middleware for mutating
   `/api/v1` requests: `Origin` must be the request's own host or `APP_URL` (else
   `Sec-Fetch-Site` must be same-origin when present), and bodies must be
   `application/json` (415). Unit tests plus e2e checks against the real server.
10. **Central access filters.** New `inAccessibleCompany` and `visiblePeopleWhere` in
    `access.ts`, used by `listPeople`, `assignablePeopleByCompany` and the project counts
    in `listCompanyCards`; `visibleTasksWhere`/`visibleEventsWhere` also limit shared rows
    to accessible companies for non-founders (no change for founders). Tested with a staff
    context.
11. **Test gaps.** Added: counts/project progress/company tab exclude the other founder's
    private tasks; expired session resolves to null (sign-out already covered); middleware
    401 / redirect with `next`; `safeNext`; seed guard; `isRemoteDatabaseUrl`;
    `listTaskEvents` after shared to private.

Open: the per-email limit lets someone who knows a founder's email lock them out for 15
minutes (accepted for two users). Behind a proxy that does not overwrite
`X-Forwarded-For` the per-IP limit can be bypassed; Vercel overwrites it.
