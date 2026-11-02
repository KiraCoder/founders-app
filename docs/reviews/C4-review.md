# C4 Numbers review (independent reviewer, commits ef2a615^..4d0f2ec)

OK: company isolation (grid, upload, REST, runner, runs listing; cross-company metric ids refused; archived hidden); latest-wins with row lock + unique current; future periods refused; due rules (day+1, week Wed after ISO Mon, month 10th) in Bishkek dates; US dates / 2-digit years refused; stubs no network, runs logged; Numbers waiting ≤3 lines, both founders, no new pushes; 0007 additive + RLS + restrict deletes.

## Must fix
1. HIGH float decimal check rejects valid KGS: src/lib/metrics.ts:252 (1234567.89*10000 → 12345678899.999998). ~10% of 2-dec values 1M–10M rejected; runner silently skips (runner.ts:290). Fix: string-based decimal check after normalisation; tests >1M.
2. HIGH xlsx % and decimals silently wrong: parse-table.ts:32 rounds numeric cells to 2 decimals ignoring numFmt. 95.5% (0.955) → "0.96" → stored 0.96%; 1.25% → 0.01. Fix: metrics import gets raw cell value + numFmt; ×100 when format has %; no rounding. (people import: keep amounts exact too.)
3. MED-HIGH granularity mismatch in upload: metrics-import.ts:134-168. Month label into daily metric → 1 Oct; into weekly → week of 28 Sep; daily file into monthly metric writes first day's value as month total, only later rows flagged. Fix: refuse cells where date is coarser than metric period; for date finer than metric period (daily rows → monthly metric) refuse unless the file has exactly one row per period … simplest: refuse and explain; mark ALL colliding rows as errors incl. first.
4. MED in-progress period counted as final + gaps invisible: resolvePeriod (services/metrics.ts:310) accepts current unfinished period; KpiCard.defaultPeriod (40-43) defaults to it; month-to-date saved → month never chased after close; change vs prev compares partial vs full (−90%). Freshness only checks latest (metrics.ts:155): gaps behind it never chased. Fix: week/month accept only completed periods (or allow current but flag `in_progress`, exclude from change + freshness — prefer: refuse current for week/month, daily may enter today); default form period = expected (oldest missing) period; count gaps within last N periods (N=7 daily, 4 weekly, 3 monthly) → missing count shown on card + in Numbers waiting.

## Can wait (do them)
5. MED Numbers waiting never clears (22 metrics, 18 connector-only not built) → daily nag. Fix: connector metrics whose connector is not configured collapse into ONE line ("4 numbers wait for Edil's APIs") or are omitted; metrics never having data: back off (mention at most weekly, e.g. Mondays) — anti-spam.
6. LOW-MED ambiguous parsing: "85.000" → 85, "12,345" → 12345. Fix: refuse \d{1,3}[.,]\d{3} patterns as ambiguous with a clear message; "%" only for % metrics.
7. LOW-MED connector design: runs overwrite manual corrections (manual should win over connector for same period unless newer manual? → rule: a connector never overwrites a manual/upload value; it records a conflict); 7-day range filter (runner.ts:287) blocks monthly metrics; daily points for weekly metric overwrite each other (aggregate per metric aggregation rule: sum|avg|last — add `aggregation` column); pull() needs AbortSignal/timeout + cursor; run row inserted as ok before writing → add 'running' status, finalise after; listConnectorStatuses calls healthCheck() on every render → cache status in connector_runs/last check, only on "Check now".
8. LOW deadlock: sort cells by metricId before locking; map deadlock error.
9. LOW: FK for metric_values.connector_run_id; REST ISO timestamps → convert to Bishkek date (or refuse non date-only); allow clearing a note; upload confirm uses sha256 of the previewed file (shared helper from C3a fixes) and refuses if data changed.
10. Tests: concurrent writes, xlsx upload incl. % and large numbers, >1M values, granularity mismatch, gaps behind latest.

## Resolution

All 10 items were fixed on branch `claude/adoring-brown-rriwam`. Verified with
`npm run db:migrate`, `lint`, `typecheck`, `test` (251 tests), `build`, `test:e2e`, and the
numbers screenshots were re-taken. New migration `0009_metrics_fixes.sql` is additive (enum
`metric_aggregation` + column, enum value `running`, `connector_runs.details`, FK for
`metric_values.connector_run_id`); no new table, so no new RLS statement (`rls.test.ts`
passes). Guiding rule: these are numbers founders decide on, so the app refuses with a clear
message rather than guessing.

1. **Float decimal check (HIGH).** `metricValueProblem` counts decimals from the number's
   shortest exact text (`decimalPlaces`), not by multiplying; text input is checked on the
   normalised string (`parseMetricInput`: at most 4 decimals, at most 15 significant digits,
   so a double never changes a typed value). Tests: 1234567.89 and 9 999 999.99 stored as
   `1234567.8900`; a sweep over 1M–10M 2-decimal values (unit and grid) rejects none.
2. **xlsx % and decimals (HIGH).** `parse-table.ts` (zip-bomb guard, UTF-16, sha256 kept)
   now returns `numbers`: for each numeric cell the stored value, its `numFmt`, `percent`
   and `shown` (×100 for percent formats; float noise removed at 15 significant digits,
   exactly what Excel keeps — no rounding). Display text no longer rounds (`95.5%`,
   `1234567.89`); a date cell formatted without a day ("mmm yyyy") becomes `2026-10` (a
   month label). The numbers upload reads values from `numbers`; a percent cell in a non-%
   column is refused. The people import reads salaries from `numbers` too and refuses more
   than 2 decimals instead of rounding. Tests generate real .xlsx files (0.955 "0.0%" → 95.5,
   0.0125 → 1.25, 1234567.89, % in a KGS column refused, salary 45000.5 / 1234567.89 kept,
   45000.555 refused).
3. **Granularity mismatch (MED-HIGH).** `parseDateCell` returns the date and its precision.
   A month label in a daily/weekly column is refused ("“Oct 2026” is a whole month, but
   Orders per day is a daily number — give the date"). When several rows land in the same
   period of one metric (daily file → monthly column, same day twice) **all** those cells are
   errors, the first included ("Rows 3, 4 are all in Oct 2026 — Revenue is a monthly
   number: one row per month with its total"). One dated row per month is that month.
4. **In-progress periods and invisible gaps (MED).** Decision implemented: daily numbers may
   be entered for today; weekly/monthly only for completed periods ("This month isn't
   finished yet" / "This week isn't finished yet") — in the form, grid, upload, REST and
   connector runner (`periodProblem`). Today's daily value is marked "so far" and excluded
   from change vs previous. Freshness counts gaps in a window of 7 days / 4 weeks / 3 months of
   due periods (`GAP_WINDOW`), also behind the latest value; periods before a metric's first
   value are not gaps. 1 missing → warn ("Waiting for 28 Oct"), 2+ → risk ("3 missing · from
   …", "7+" when the latest value is older than the window). The form opens on the oldest
   missing period (`defaultEntryPeriod`) and its date picker stops at the last finished
   week/month; the grid's rows end there too. Tests: gap behind latest (card, stale list,
   default period), refusals, "so far" without change.
5. **Numbers waiting never clears (MED).** `staleMetricsFor` adds `hasData` and
   `awaitingSource` (from the connector's static `setup()`, no network). The summary shows:
   late numbers that had data — daily, max 3 lines as before; on **Mondays only** (Bishkek)
   one line "Never entered yet: …" and one line "18 numbers wait for data sources (Edil's
   APIs, WB token)". Unit tests for Monday vs Tuesday; integration test of the real
   dispatcher on Monday.
6. **Ambiguous parsing (LOW-MED).** "85.000", "12,345" (1–3 digits, one separator, 3 digits,
   not starting with 0) are refused with a hint ("ambiguous: 85 or 85000? Write 85000 if you
   mean thousands, or 85 for a decimal"); "1,234,567", "1,234.5", "1 234,5", "0,125" still
   work. "%" is accepted only for % numbers. The grid prefill writes "85.1250" for 3-decimal
   values so it reads back the same.
7. **Connector design (LOW-MED).** Decisions implemented: (a) a connector never overwrites a
   manual/upload value for the same period: equal → unchanged, different → nothing written,
   recorded in `connector_runs.details.conflicts` and the card shows "Source disagrees:
   Kiwi Go app says 130 for 31 Oct (kept 120 entered by hand)" until the values agree or the
   founder changes it; Settings shows "N differ from numbers entered by hand". Connector →
   connector still updates (latest wins). (b) `metric_definitions.aggregation` (sum | avg |
   last), seeded: avg for %, last for people counts and the intercompany debt balance, sum
   otherwise (0009 sets existing rows the same way). Daily points for weekly/monthly metrics
   are aggregated only for complete periods fully inside the range with every day received
   ("last" needs the last day); avg is rounded to the stored 4 decimals; incomplete periods
   are skipped with a reason in `details.skippedReasons`. (c) A point is kept when its period
   overlaps the range, so monthly points work; "Check now" pulls from the 1st of last month to
   yesterday. (d) The run row is inserted as `running` and finalised (ok / error /
   not_configured) after the writes; a `running` row older than 10 minutes shows as
   interrupted. (e) `pull(range, { signal, cursor })`: 60 s `AbortSignal` time limit for the
   whole pull (also enforced if a connector ignores the signal), 15 s for the health check,
   pages via `nextCursor` (max 50 pages / 50 000 points, repeated cursor refused). (f) Pages
   never call `healthCheck()`: `listConnectorStatuses` uses the connector's static `setup()`
   and the last recorded run; only "Check now" contacts the source. Tests for each.
8. **Deadlock (LOW).** Grid, upload and runner write in metric-id then period order
   (`byMetricThenPeriod`); `toServiceError` maps 40P01 / 40001 (also wrapped as `cause`) to a
   `conflict` "Someone else saved at the same moment … try again". Tests: two grid saves in
   opposite order, four concurrent entries for one period (one created, one current row).
9. **Small items (LOW).** FK `metric_values.connector_run_id → connector_runs(id) ON DELETE SET
   NULL` (0009 clears dangling ids first). REST periods must be dates: any time / `T` / zone
   is refused ("Give the date without a time"); plain midnight from spreadsheet exports
   ("31.10.2026 0:00:00") is read as the date. Notes: omitted keeps, `null` / `""` clears
   (the card form keeps the note when its field is empty). Upload confirm already required
   the sha256 of the previewed file (C3a `assertSameFile`), unchanged and still tested.
10. **Tests.** `tests/integration/metrics-hardening.test.ts` (18 tests: concurrent writes,
    real .xlsx with % and large numbers, >1M values, granularity mismatch, gaps behind latest,
    connector conflict / aggregation / monthly range / running / timeout / pages / cached
    status, notes, REST timestamp), new unit tests in `tests/unit/metrics.test.ts`, 0009
    migration test in `tests/integration/migrations.test.ts`.

Behaviour the founders should know: the current week/month can't be entered until it ends;
"85.000"-style numbers must be retyped; a source never replaces their own numbers (they see
"source disagrees" instead); connector-only and never-entered numbers are mentioned only on
Monday mornings. Open: real connectors still to be written (stubs only); connector-fed
metrics that a founder enters by hand while the source is not set up are still treated as
"waiting for a data source" (Mondays only), not chased daily.
