# C5a AI roles + rule-based Financial Analyst review (independent reviewer, commits up to a260464)

OK: founders-only access on every AI role route and service (`assertAiRolesAccess`); one hire
per role and company; the run state machine `waiting_for_data → ready → analysed → reported`;
exact decimals everywhere (no floats); ONE "report ready" push per recipient per run (outbox
dedupe key) following quiet hours, budget/parking and "not linked"; Create task only on a
founder's click; no vendor SDK, key or network call (`AI_PROVIDER=none` is the only provider);
0012 additive with RLS on all four new tables; only the two founders are ever asked or notified.

## Must fix
1. MED-HIGH wrong severity in the change rule (`finance-rules.ts:123-128`): `riskHit` ORs the
   month-before and 3-month-average checks irrespective of direction; the direction comes from
   the month before only. Repro: revenue 10, 10, 100 → 75 is a **risk** for a 25 % drop
   (because it is +87.5 % vs the average); 100, 100, 10 → 30 is **info** although it "fell
   57.1 % vs the 3-month average". Fix: judge each comparison on its own (direction +
   thresholds), keep the worse; the sentence must name the comparison that triggered.
2. MED a salary-like metric name kills the whole report even with no provider
   (`narrative.ts:182-183`, `services/ai-roles.ts:467-470,489-492`): the prompt is built before
   the `provider.configured` check → throw → run failed → retried every tick forever. The guard
   is name-only: "Payroll fund", "ФОТ", "Wages", "Оплата труда" pass. Fix: no prompt without a
   provider; with one, drop/redact salary-like findings and record `narrative_skipped:salary`
   instead of failing; wider word list (payroll, wage(s), salary, зарплат, ФОТ, оплата труда,
   оклад), match metric keys too. Piecework pay TOTAL stays allowed only by explicit key.
3. MED the role asks founders to enter the derived intercompany-debt number
   (`orchestrator.ts:265-272`): it is suppressed only while today's Holding section has lines;
   after "I asked Elmurat" the role chases "enter it" daily, and a manual entry then blocks
   future derived updates (`kept_manual`). Fix: always exclude holding-fed (derived) numbers
   from role data requests; the Holding owns asking.
4. LOW-MED false "Numbers changed" banner after Tune (`services/ai-roles.ts:389-391`, `:834`):
   the hash includes thresholds / required keys. Fix: separate inputs and settings hashes;
   "Settings changed since this report — Run again" (distinct copy).

## Also fix
5. Failed runs retried every tick with no backoff and no visibility (`planAiRoles` :540-548);
   a failure after `reported` drops the reported status.
6. Race losing a task link: `evaluateRun` reads/overwrites findings without the row lock that
   `createTaskFromFinding` holds → a link lost and a duplicate task on the next click.
7. Pause/resume or a founder "asks" toggle restarts the 7-day daily cadence (:595-599).
8. An AI request hides "Numbers waiting" for every period of the number, not only the months
   the role asks for.
9. Request lines list every month; % metrics phrased as relative % ("rose 50 %" for 3 % → 4.5 %).
10. (Found by hand) "Numbers used" shows "Orders per day" with a monthly total (3 100 orders):
    month aggregates must be labelled as such.
11. (Product, not implemented) connector-only daily metrics (orders, on-time delivery, COD…) need
    every day of the month, i.e. 90+ manual values a month per company until the APIs exist.

## Resolution

Items 1–10 fixed on `claude/adoring-brown-rriwam` (one commit per item, f28f988..5541c85, plus this document).
Item 11 left as is by decision (see below). Verified with `npm run db:migrate`, `lint`,
`typecheck`, `test` (37 files, 370 tests), `build`, `test:e2e` (12 passed, screenshots skipped
by default) and `SCREENSHOTS=1 npx playwright test screenshots -g "AI roles screenshots"`
(`docs/screenshots/ai-report.png` re-taken: new month labels). New migration
`0013_ai_roles_fixes.sql` is additive (`ai_role_runs.settings_hash` nullable,
`attempts integer default 0 not null`, `next_attempt_at` nullable); no new table, so no new RLS
statement (`rls.test.ts` passes; 0013 on existing data tested in `migrations.test.ts`). Still no
SDK, key or network call.

1. **Change rule severity (MED-HIGH).** `changeRule` builds one comparison per basis (month
   before, 3-month average), each with its own direction (`cmp(cur, base)`), warning threshold
   and risk threshold; the worst severity wins and that comparison leads the sentence and picks
   the numbers in brackets (on a tie the month before comes first, so existing sentences are
   unchanged). Tests (`ai-finance.test.ts`): 10, 10, 100 → 75 is a **warning**, "Revenue fell
   25% vs September and rose 87.5% vs the 3-month average (Sep: 100 KGS, Oct: 75 KGS)";
   100, 100, 10 → 30 is a **risk**, "Revenue fell 57.1% vs the 3-month average and rose 200% vs
   September (3-month average: 70 KGS, Oct: 30 KGS)". An average-only hit now shows the average
   in brackets (test updated).
2. **Pay data never fails a report (MED).** `generateNarrative` returns `narrative_skipped`
   before building anything when no provider is configured. With a provider, findings for which
   `salaryLikeFinding` is true (metric key, metric label, number label or sentence) are left out
   of the prompt and counted; if `buildNarrativePrompt` still refuses (e.g. a pay word in the
   company name) nothing is sent and the run records `narrative_skipped:salary`; any other
   prompt error is `narrative_failed` — never a failed run. Word list: salary, payroll, wage(s),
   зарплат…, заработн…, ЗП, ФОТ (not "фото"), оплата труда, оклад; keys: `salary`, `payroll`,
   `wage(s)`, `fot`, `zp`, `oklad`, `zarplat…` as snake_case parts. `ALLOWED_PAY_KEYS =
   {piecework_total}`: a finding whose keys are all on it is exempt from the word check (so
   "Сдельная оплата труда · ХБК" works), salary-only fields stay refused everywhere. The report
   page says how many findings were left out, or "No AI summary for this report: it would have
   included pay data…". Tests: unit (each word / key, piecework by key only, no-provider path,
   omitted count, refused prompt → `narrative_skipped:salary` with no provider call) and
   integration (a "Payroll fund" hire: reported without a provider; with a capture provider the
   prompt has neither "payroll" nor the amount).
3. **Holding-fed numbers are never asked by a role (MED).** `holdingFed(def)` = the
   intercompany-debt key or `source_kind = derived`. `collectAiRequests` puts those into
   `waitingOnHolding` instead of `missing`, so they are never on a role's line (whatever the
   Holding section shows that day); they still hide the number from "Numbers waiting", and the
   Holding section's muted "…is waiting for these акты too" line stays when it has an ask line.
   `composeRequests` also drops the debt key from `missing` (defence in depth). The report page
   marks such a number "computed from the Holding акты — no need to enter it" and the Numbers
   deep link points at the first number that can be entered. Tests: composition on the "already
   asked" day (Holding section null / empty → no AI line), a real Asqa Zou Holding hire (request
   has `missing: []`, `waitingOnHolding: [Intercompany debt total]`, no line).
4. **Settings vs numbers (LOW-MED).** Runs store `inputs_hash` (numbers only) and
   `settings_hash` (required keys + thresholds). `getRun` returns `inputsChanged` and
   `settingsChanged`; the page shows "Numbers changed" or a distinct info banner "Settings
   changed — The role was tuned after this report… run it again". Rows from before 0013
   (`settings_hash` null) are compared with the old combined hash and reported as numbers, as
   before. Tests: Tune → `settingsChanged` only; Run again clears both; a legacy row.
5. **Retry backoff and visibility.** On a failure `attempts + 1` and `next_attempt_at` = now +
   1 h / 6 h / 24 h (then every 24 h); the tick skips a run until then and leaves it alone after
   `MAX_RUN_ATTEMPTS = 5` (`next_attempt_at` null). A success resets both. The report page shows
   the error, tries so far and the next try, or **Failed — Retry** with a Retry button after 5;
   the hire card summary says "Failed 5 times — stopped retrying; Retry on the report". A failure
   while re-analysing a run that is already `analysed` / `reported` keeps its status and its
   last good findings (only `error` / `attempts` change; page: "Update failed … This is the last
   good report"). Test: the whole sequence through `orchestrateTick` (12:10 and 12:50 skipped,
   13:00 → 2, 19:05 → 3, … 5 → stopped; Retry → reported; a later failing re-run keeps the
   report, `reportedAt` and findings).
6. **Task link race.** The re-analysis result is written in a transaction that first takes
   `SELECT … FOR UPDATE` on the run (the lock `createTaskFromFinding` takes) and copies task links
   by finding id from the locked row. The (possibly slow) narrative call stays outside the lock.
   Test: a provider that clicks "Create task" between the analysis and the write — the link
   survives and a second click returns the same task (`created: false`).
7. **Cadence kept on revive.** A request cancelled as `paused` / `not_asked` comes back with its
   original `created_on` and `last_shown_on` (only status / reason / resolved_at reset). Test:
   pause + resume and an "asks" toggle keep both dates; Nuraaly (weekly phase) is not due the day
   after.
8. **Suppression per period.** Each `missing` / `waitingOnHolding` entry carries the months it is
   missing for; `composeRequests` hides a "Numbers waiting" item only when the month of its
   `waitingFor` is one of them. Test: a daily number late for 2 November stays while the role
   asks for October; late for 15 October is hidden.
9. **Short month lists, pp for percentages.** `monthsLabel`: consecutive months as a range
   ("August–October 2026", "November 2025–January 2026"), otherwise the newest 3 named plus
   "(+N earlier)". Percentage metrics (unit `%`) in the change and ratio rules: "Defect rate rose
   1.5 pp vs September, from 3.0% to 4.5%"; a missed % target is "off by 0.6 pp". Tests for
   both.
10. **Month labels.** `monthlyName` (`month-values.ts`): a daily/weekly number summed over the
    month is "Orders (month total)", averaged "Average on-time delivery", last "Active couriers
    (end of month)"; monthly numbers keep their name. Used for the analysis series (findings) and
    "Numbers used"; "missing" / "never entered" findings and the data requests keep the name
    founders enter ("On-time delivery", "Orders per day"). Footnote under the table reworded.
    Tests: unit for each aggregation; integration (Kiwi Go: "Orders (month total)" = 3100).
11. **Not implemented (product decision).** Connector-only daily numbers (Kiwi Go orders,
    on-time delivery, COD collected / paid out; Jobutify WMS) are "complete" only with every day
    of the month, so until the connectors exist the founders would have to type 90+ values a
    month per company (or upload a file) before the analyst runs. Left as is; options for the
    founders: drop those numbers from "waits for" in Tune (they are still used when present), or
    a monthly-total entry for connector numbers later.

Founder-facing changes: different (correct) severities on some change findings and sentences
that lead with the comparison that matters; % numbers in percentage points; "Numbers used"
labels say month total / average / end of month; no more "enter Intercompany debt total"
lines from the analyst; a role's line no longer hides other months from "Numbers waiting";
request lines name at most 3 months; resuming a role or re-adding a founder does not restart
daily chasing; "Settings changed" banner after a Tune; failed runs retry 1 h / 6 h / 24 h and
show "Failed — Retry" after 5 tries; with a future provider, pay findings are left out of the
AI summary (and said so).
