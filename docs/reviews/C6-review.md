# C6 Holding review (independent reviewer, commits aabda0f^..41c180f)

OK: founders-only access on every holding route and service (assertHoldingAccess); акты grid
rules (grace days, before start / after end, recorded status wins); debts netted per pair in
cents; contracts expiry warnings; file type by magic bytes, founders-only download with
nosniff / no-store; 0010 additive with RLS on all six new tables; Elmurat is never a
recipient — only the two founders get the asks, inside the morning summary.

## Must fix
1. MED-HIGH anti-spam: ask/reminder items pile up when a summary isn't delivered
   (`holding-asks.ts:84-95`, `:151-177`). The planner inserts a new round each month / Monday
   without looking at the founder's older pending items, and `holdingSummarySection` shows
   all of them. Reproduced: Talant not linked 11 Nov–13 Dec, linked Mon 14 Dec → 4 identical
   "Still waiting…" lines + the Dec ask line (5 buttons). Same after failed sends or quiet
   hours covering the window. Fix: on inserting a round, cancel that user's older pending
   items of the same kind (`superseded`); backstop in the summary: at most one item per kind,
   months de-duplicated. Tests incl. not_linked.
2. MED money: the derived "Intercompany debt total" is only written for the previous month
   (`holding.ts:843`); a late акт/payment for an older month leaves that month wrong forever
   (Nov stays 100.10 instead of 300.30). When debt data goes back to nothing (all archived)
   it returns skipped/no_data and leaves a stale derived value. Fix: recompute every month
   from the earliest affected month to the previous month, only over `derived` rows; handle
   "no data" for months that had a derived value. Test.
3. LOW-MED flaky test `holding-notifications.test.ts:151` (~25 s vs 30 s timeout).

## Also fix
4. Upload size vs Next middleware body clone limit (10 MiB): files near 10 MB truncated → 400.
   Raise `middlewareClientMaxBodySize`, clear 413; README note on Vercel's 4.5 MB limit.
5. Archived/planned flows' акты count in debts, but an archived flow's акт can't be corrected.
6. Telegram `editMessageText` without `reply_markup` strips all buttons from the summary.
7. Orphan files: bytes written before the DB insert; uploads never attached are kept forever.
8. Missing months older than the 13-month grid silently stop being asked about.
9. PDFs served inline with `CSP: sandbox` may not render in Chrome's viewer.
10. UI: company page `<title>` shows the slug ("kiwi go"); date inputs show mm/dd/yyyy in an
    English browser.

## Resolution

All 10 items fixed on `claude/adoring-brown-rriwam`. Verified with `npm run db:migrate`,
`lint`, `typecheck`, `test` (33 files, 306 tests, ~51 s; the longest holding notification
test now ~6.5 s), `build`, `test:e2e` (11 passed, screenshots skipped by default) and
`SCREENSHOTS=1 npx playwright test screenshots` (all screenshots re-taken: date fields
changed everywhere). New migration `0011_holding_fixes.sql` is additive (column
`holding_files.attached_at` + partial index, backfilled for files already attached); no new
table, so no new RLS statement (`rls.test.ts` passes; 0011 tested in `migrations.test.ts`).

1. **Ask items pile up (MED-HIGH).** `planHoldingAsks`: when a round is inserted for a founder,
   that founder's other *pending* items of the same kind are cancelled with reason
   `superseded` — the new round is built from the whole grid, so it already covers every
   month still open. Backstop in `holdingSummarySection`: pending items are grouped by kind;
   at most one line + one button per kind; if several are pending, their still-open months
   are merged (de-duplicated) into the newest item (so its button covers all of them) and the
   older ones are cancelled as `superseded`. Test `holding-asks-pileup.test.ts`: the review's
   exact case through the real planner + dispatcher with a Telegram-like registry (Talant not
   linked 11 Nov–13 Dec → only `ask|2026-12` and `reminder|2026-12-07` pending, older
   reminders superseded; after linking on Mon 14 Dec his summary has exactly one ask line and
   one reminder line, two buttons); failed sends over two Mondays → one pending reminder; the
   backstop merge with a manually inserted duplicate.
2. **Debt metric (MED).** `syncDebtMetric(db, now, tz, { fromMonth })`: the tick still writes
   only the latest finished month; after a debt change the caller passes the earliest month
   it touches (an акт: the earliest of its period, old and new act date; a ledger entry or a
   cancelled one: its date) and every month from there to the latest finished one is
   recomputed (as of each month's last day) in one transaction. Only months whose current
   value is `derived` (or empty) are written; a manual / upload / connector value is kept
   (reported `conflict` when it differs). **Decision: no data → 0, not retraction.** A month
   with no debt data stays empty, unless it already had a derived value: then 0 is written as
   a new version (history kept). Metric values are never deleted elsewhere in the app and "no
   recorded debt" is what 0 means, so the card can't keep a stale total. Tests in
   `holding-fixes.test.ts`: the review repro (Nov 100.10 → 300.30 after a late October акт), a
   founder's October number kept while November is recomputed, every entry gone → derived
   months 0 (manual month untouched). `holding.test.ts` updated (Jan–Oct now derived).
3. **Flaky test (LOW-MED).** The holding notification tests tick at 07:00, 08:30, 09:30 and
   12:00 instead of every 30 minutes; the reminder test runs in ~6.5 s (was ~25 s).
4. **Uploads near 10 MB.** `next.config.ts`: `experimental.middlewareClientMaxBodySize: "11mb"`
   (key verified in the installed Next 15.5.28 `config-shared.d.ts` / `config-schema.js`).
   The route still reads at most 10 MB + 64 KB and answers 413 "The file is larger than 10 MB
   — scan it at a lower resolution or split it, then upload again" for a declared or streamed
   oversize body; the browser helper shows that message (also for a platform 413). README:
   Vercel refuses bodies over 4.5 MB, so the Supabase adapter will need a signed direct upload.
   e2e: a 10 MB − 1 KB PDF uploads through the real middleware and comes back byte-identical;
   10.3 MB gets the 413 message.
5. **Archived flows' акты.** `patchAct` accepts an archived flow for an акт **already
   recorded**, changing only status (not "requested"), amount and act date (the date decides
   which month the debt counts from); anything else (new акты, notes, scans, asked dates)
   asks to restore the flow. Founders only, like all of holding. UI: *Flows → Show archived →
   Correct акты (N)* lists the recorded акты with status + amount. `listArchivedFlowActs`.
   Debt metric recomputed as in 2. Tests in `holding-fixes.test.ts`. README documents it.
6. **Telegram buttons.** After a press, `editMessageText` now carries `reply_markup` with the
   keyboard Telegram sent back minus: the pressed button, buttons for the same task / ask
   item, and any token that is used or expired (`liveCallbacks`, read-only server-side
   check). Test: Talant's two-button summary → after "I asked Elmurat" the "I asked again"
   button stays; after that one, no keyboard.
7. **Orphan files.** `saveHoldingFile` inserts the metadata row first and writes the bytes
   second; a failed write deletes the row (and any partial bytes). New `attached_at` is set
   the first time a file is attached to an акт or договор; `cleanupUnattachedFiles` (run from
   `runTick`, max 20 per run) deletes uploads never attached and older than 24 h — the DELETE
   re-checks atomically that no акт / договор points at the file, then removes the bytes. A
   document attached once is never deleted, even if replaced later. `FileStorage.delete`
   added (Supabase placeholder still refuses everything). Tests: failed write → no row;
   failed insert → no file; 23 h → nothing removed, 25 h → only never-attached files removed.
8. **Older missing months.** `loadActsGrid` adds `row.older`: months before the grid's first
   column (back to the flow's start, not before 2015) that are missing or requested. They
   count in `grid.missing` / `requested`, are part of the ask item, the reminder, the
   copyable message ("сентябрь, ноябрь, декабрь 2025") and "I asked Elmurat". The flow row
   shows "N older missing" (· "N older asked"); clicking opens the oldest one in the panel.
   The "Missing акты" stat hint now says "All months since each flow started". Test in
   `holding-fixes.test.ts`.
9. **PDF rendering.** PDFs are served `inline` with nosniff, `private, no-store`, founders
   only, **without** the sandbox CSP (Chrome's PDF viewer refuses sandboxed documents);
   images keep the sandbox CSP. The reasoning (magic-byte check, exact type + nosniff,
   founders only, PDF scripting runs in the viewer's sandbox) is in the route. Tested
   (integration + e2e).
10. **UI.** The company page title uses the company name ("Kiwi Go · Founder Cockpit").
    `lang="ru"` does not reliably change a native date picker's format (Chrome follows the
    browser locale), so all 14 date fields use a new `DateInput`: text in **dd.mm.yyyy**
    (also d.m.yyyy, "/" or "-", pasted ISO), impossible dates / 2-digit years / outside
    min-max refused with "Use dd.mm.yyyy, e.g. 02.11.2026" (blocks the form), normalised on
    blur, ISO submitted to the server, calendar button opening the browser's own picker. UI
    language stays English. Unit tests for `parseDisplayDate` / `formatDisplayDate`; e2e for
    the title and the field.

Behaviour the founders should know: an undelivered summary no longer stacks up holding lines —
the latest round replaces older ones; a late акт or payment now corrects the debt KPI for every
month after it (their own typed numbers are never overwritten), and months whose debt entries
were all cancelled show 0; акты of archived flows can still be corrected (status, amount, act
date); акты missing for more than a year are asked about too ("N older missing"); scans not
attached within 24 h are deleted; all date fields are dd.mm.yyyy.

Open: on Vercel uploads above ~4.5 MB fail until the Supabase storage adapter with signed
direct upload is written (the adapter is still a placeholder; local disk is not kept on
Vercel). Debt metric rows written before this fix for older months are corrected the next time
a debt change touches them (the tick only refreshes the latest month).
