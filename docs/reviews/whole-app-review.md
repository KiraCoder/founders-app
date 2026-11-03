# Whole-app review (independent reviewer, commits up to 036f006)

A month-long simulation (1–30 Nov 2026, both founders linked to Telegram, a tick every 30
minutes, the Financial Analyst hired for Kiwi Go, October data entered on 12 Nov) showed
Nuraaly getting 2–6 Telegram messages a day: the morning summary, up to 4 pushes and an
evening check almost every day. The brief's main complaint about the old cockpit was too many
pushes, so noise matters as much as correctness.

## Must fix
1. HIGH a summary over 4096 characters silently drops the Holding ask and the AI requests
   (`render-telegram.ts:44-48` cuts the tail; Holding and AI are last, `messages.ts:142-147`)
   while the dispatcher still marks them shown / bundled (`dispatcher.ts:439-445`), so they are
   never asked again. Repro: 12 overdue + 4 today + 10 this week + 8 personal + 6 parked,
   80-character titles.
2. HIGH migrations are never applied to Supabase after the first setup: the README says
   "create the tables once" and nothing runs `db:migrate` on deploy, so every new table breaks
   production pages.
3. HIGH production silently falls back to PGlite when `DATABASE_URL` is empty
   (`connect.ts:41-47`): on Vercel the data lands on a temporary per-instance disk.
4. MED document uploads fail on Vercel: `LocalFileStorage` writes under the working directory,
   which is read-only there; the upload field is shown anyway.

## Noise reduction
5. "Parked reminders" repeats tasks already listed in the same message
   (`dispatcher.ts:126-170`, `messages.ts:186-196`).
6. The evening check goes out almost every day only because something is overdue (already in
   the morning summary).
7. The "report ready" push arrives at 08:00, 30 minutes before the 08:30 summary.
8. The AI line says "enter Orders per day…" while Monday's "18 numbers wait for data sources"
   covers the same metrics.

## Also
9. No branded `error.tsx` / `global-error.tsx` (Next's default error page).
10. Hard-coded timezone / locale: `ai-roles/runs/[id]/page.tsx:64,123` (`ru-RU`,
    `Asia/Bishkek`) and `connectors/runner.ts:84,93`.
11. README env coverage: `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, the 7 connector
    variables, `FILE_STORAGE` undocumented; the cron route has no `maxDuration` and pg_net's
    default timeout is 5 s.
12. The sample task "[sample] Ask Elmurat for missing October акты" duplicates the Holding ask.

## Resolution

All 12 items fixed on `claude/adoring-brown-rriwam`, one commit each (plus a README commit for
1 and 5–8 and a build fix for 3). Verified with `npm run db:migrate`, `lint`, `typecheck`,
`test` (40 files, 399 tests, was 370), `build` and `test:e2e` (12 passed, screenshots
skipped by default). No migration, no new table.

1. **Summary length.** The morning summary is now: counts → Holding ask → AI role requests →
   task sections → parked → Numbers waiting. Everything but the task sections is kept whole;
   the task sections share the rest of a 4032-character budget (`SUMMARY_TEXT_BUDGET`) and end
   with "+N more — open the app" (also at the 8-per-section cap; `/tasks` uses the same
   budget). Lines carry `refs` (`p:` parked outbox row, `h:` holding ask item, `ai:` data
   request). `fitTelegram` (render-telegram.ts) drops whole lines from the end if a message is
   still too long, removes the buttons of holding items whose line was dropped, and returns
   `keptRefs`; the dispatcher sends the fitted message and marks holding items shown, AI
   requests shown and parked rows bundled **only** for kept refs (parked rows behind "+N more"
   now stay parked for the next summary instead of being bundled unseen). Tests:
   `tests/unit/notifications-summary.test.ts` (the reviewer's repro: 3 940 characters,
   Holding and AI right after the counts, all refs kept, every task either a line or in
   "+N more"; `fitTelegram` drops lines and reports refs/buttons), integration "bundles only
   the parked items whose line made it into the summary" (11 parked → 8 bundled, 3 stay).
2. **Migrations on deploy.** README step 7 "Every time you deploy new code: update the
   database too" (`npm run db:migrate` against Supabase). New `npm run db:migrate:deploy`
   (`scripts/db-migrate-deploy.ts`, decision in `migrateOnBuildDecision`): runs only with
   `MIGRATE_ON_BUILD=1` and a `DATABASE_URL`, otherwise prints "skipped" and exits 0; usable
   as Vercel Build Command `npm run db:migrate:deploy && npm run build`. Default off; both
   ways documented. Tests: `tests/unit/migrate-deploy.test.ts`.
3. **No silent PGlite in production.** `resolveDatabaseUrl` (`src/server/db/database-url.ts`,
   import-free because instrumentation is also bundled for edge) throws in production without
   `DATABASE_URL`; called in `instrumentation.ts` next to the `SESSION_SECRET` check and in
   `getDb()`. `ALLOW_LOCAL_DB=1` allows a local production test (Playwright sets it). Tests in
   `seed-and-auth.test.ts` (function + `register()`).
4. **Uploads on Vercel.** `fileUploadStatus()`: in production uploads need
   `FILE_STORAGE=local` on a server with a lasting disk (ignored when `VERCEL=1`); empty or
   `supabase` (still a placeholder) → off. Then the scan fields on /holding show "File uploads
   arrive with Supabase storage" (`UploadsProvider` context), `POST /api/v1/holding/files`
   answers 503 `{ code: "unavailable", message: "File uploads arrive with Supabase storage" }`
   before reading the body, and `saveHoldingFile` refuses too. FILE_STORAGE documented
   (README, `.env.example`); e2e sets `FILE_STORAGE=local`. Tests in `holding-files.test.ts`.
5. **Parked de-duplication.** A parked item whose task has a line in a section of the same
   message (summary or evening check) gets no "Parked reminders" line; its outbox rows are
   attached to that task's line (bundled only if it is shown). Tests: unit (shown task
   attached, a task behind "+2 more" keeps its parked line, evening check), integration
   "does not repeat a parked task that the summary already lists".
6. **Evening check.** `buildEveningCheck` returns null unless something due today is open or
   parked items wait that no summary listed; overdue alone no longer triggers it (the
   overdue count stays as a note when it is sent). A skipped check still cancels parked rows
   that are no longer relevant. Unit tests for the three cases; the hardening test for a moved
   deadline adjusted.
7. **Fold into the summary.** `shouldFoldIntoSummary` (dispatcher): a push of budget class
   *normal* (never urgent-priority) is parked as `folded_into_summary` (no budget) when today's
   morning summary has not gone out and now is within 60 minutes before it
   (`FOLD_BEFORE_SUMMARY_MINUTES`) or between the end of quiet hours and the summary — or the
   summary is due and still waiting in the same run (up to 60 minutes late). The summary then
   lists it; a "report ready" line now carries the report link. Tests: integration (06:30 and
   08:00 reminders folded with quiet hours ending 05:00, urgent one sent, both bundled into the
   08:30 summary, a 10:00 push goes on its own; report push at 08:00 folded); quiet-hours and
   AI report tests updated (Talant's report folded into the summary that goes out when he
   links).
8. **Connector-only AI requests.** `collectAiRequests` marks a missing number whose data source
   is not configured (`awaitingSource`, same rule as `staleMetricsFor`). The role line says
   "— enter by hand or upload until the data source is connected: …" (all such numbers) or
   "— enter them (the data-source ones by hand or upload until it is connected): …" (mixed).
   `composeRequests` drops such numbers from "Numbers waiting" for every period while the
   request is active, so they leave the Monday "N numbers wait for data sources" line (Mon
   16 Nov in the simulation without data entry: 18 → 15, and the AI line reads as above).
   Test in `ai-roles.test.ts`.
9. **Error pages.** `src/app/error.tsx`, `src/app/(app)/error.tsx` (inside the shell) and
   `src/app/global-error.tsx` render `ErrorScreen`: "This page could not be loaded", "Nothing
   you entered was lost", *Try again*, *Back to Today*, and only the error's reference
   (digest) — never its message or stack. `not-found.tsx` already existed. Vitest now compiles
   JSX (`oxc.jsx`), and `tests/unit/error-pages.test.ts` renders all four.
10. **Timezone / locale.** New `formatDisplayDateTime` (`dd.mm.yyyy HH:MM` in the app timezone)
    on the report page (with `ctx.timeZone`); `recentRange`, `checkRange` and `runConnector`
    default to `appTimeZone()`. Tests in `dates.test.ts`.
11. **Env coverage.** README "Environment variables (all of them)" table: every variable in
    `.env.example`, the Supabase keys and the 7 connector variables marked *Not used yet*,
    `FILE_STORAGE`, `MIGRATE_ON_BUILD`, `ALLOW_LOCAL_DB`. Cron route `export const
    maxDuration = 60`; the pg_cron snippet sets `timeout_milliseconds := 60000` with a note on
    pg_net's 5 s default. Test asserts the route's `maxDuration`.
12. **Sample data.** The "[sample] Ask Elmurat for missing October акты" task is gone from the
    seed (existing local databases keep it until `npm run db:reset`). Test in
    `seed-and-auth.test.ts`.

### Messages per day, before / after (items 5–8)

The reviewer's simulation (`month2.test.ts`, run with `SIM_ENTER=1 SIM_END=2026-11-30`) on
036f006 and on the fixed code. Cell = messages that day (p = separate pushes, +E = evening
check; the morning summary is always 1).

| | Nuraaly before | Nuraaly after | Talant before | Talant after |
| --- | --- | --- | --- | --- |
| Messages in 30 days | 98 | 71 | 91 | 66 |
| Per day (avg / min / max) | 3.27 / 2 / 6 | 2.37 / 1 / 6 | 3.03 / 1 / 5 | 2.20 / 1 / 5 |
| Evening checks | 30 | 4 | 29 | 5 |
| Separate pushes | 38 | 37 | 32 | 31 |
| Days with 4+ messages | 12 | 4 | 7 | 4 |

| Nov | Nuraaly before | Nuraaly after | Talant before | Talant after |
| --- | --- | --- | --- | --- |
| 1 | 5 (3p +E) | 5 (3p +E) | 1 (0p) | 1 (0p) |
| 2 | 4 (2p +E) | 3 (2p) | 3 (1p +E) | 3 (1p +E) |
| 3 | 3 (1p +E) | 3 (1p +E) | 4 (2p +E) | 4 (2p +E) |
| 4 | 6 (4p +E) | 6 (4p +E) | 4 (2p +E) | 4 (2p +E) |
| 5 | 5 (3p +E) | 5 (3p +E) | 5 (3p +E) | 5 (3p +E) |
| 6 | 4 (2p +E) | 3 (2p) | 5 (3p +E) | 5 (3p +E) |
| 7 | 3 (1p +E) | 2 (1p) | 4 (2p +E) | 3 (2p) |
| 8 | 5 (3p +E) | 4 (3p) | 3 (1p +E) | 2 (1p) |
| 9 | 2 (0p +E) | 1 (0p) | 4 (2p +E) | 3 (2p) |
| 10 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 11 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 12 | 5 (3p +E) | 3 (2p) | 4 (2p +E) | 2 (1p) |
| 13 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |
| 14 | 2 (0p +E) | 1 (0p) | 2 (0p +E) | 1 (0p) |
| 15 | 4 (2p +E) | 3 (2p) | 2 (0p +E) | 1 (0p) |
| 16 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |
| 17 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 18 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 19 | 4 (2p +E) | 3 (2p) | 3 (1p +E) | 2 (1p) |
| 20 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |
| 21 | 2 (0p +E) | 1 (0p) | 2 (0p +E) | 1 (0p) |
| 22 | 4 (2p +E) | 3 (2p) | 2 (0p +E) | 1 (0p) |
| 23 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |
| 24 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 25 | 3 (1p +E) | 2 (1p) | 3 (1p +E) | 2 (1p) |
| 26 | 4 (2p +E) | 3 (2p) | 3 (1p +E) | 2 (1p) |
| 27 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |
| 28 | 2 (0p +E) | 1 (0p) | 2 (0p +E) | 1 (0p) |
| 29 | 4 (2p +E) | 3 (2p) | 2 (0p +E) | 1 (0p) |
| 30 | 2 (0p +E) | 1 (0p) | 3 (1p +E) | 2 (1p) |

The evening check is the big win (−26 / −24 messages); the report-ready push went into the
summary (−1 each). Without data entry (`SIM_ENTER` off) the totals are the same shape: Nuraaly
97 → 71, Talant 90 → 66.

Behaviour the founders should know: the morning summary starts with what needs them to act
(ask Elmurat, numbers for an AI role), long task lists end with "+N more — open the app"; the
evening check comes only when something due today is still open or a reminder was held back;
reminders due just before the morning summary arrive inside it; the production site refuses to
start without `DATABASE_URL`; uploads show "File uploads arrive with Supabase storage" on
Vercel; after deploying new code, run `npm run db:migrate` against Supabase (or turn on
`MIGRATE_ON_BUILD`).

Open:
- The remaining separate pushes are almost all overdue chases (day 1, 3, 7, then weekly, up to
  the daily budget of 3 plus 2 urgent-priority): Nuraaly still has a 6-message day (4 Nov:
  3 normal + 1 urgent chase). A further cut (e.g. one grouped "N tasks overdue" push, or a
  lower default budget) is a product decision for the founders.
- Uploads in production wait for the Supabase Storage adapter (signed direct upload, see the
  4.5 MB Vercel limit in the README).
- `db:migrate:deploy` uses `DATABASE_URL` (transaction pooler); if a migration ever needs a
  session connection, a separate migration URL would be the next step.
- Screenshots were not re-taken (no screen changed visibly with the sample data; the dev-inbox
  summary order changes only when Holding / AI lines are present).
