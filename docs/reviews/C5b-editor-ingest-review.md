# C5b AI role editor + browser extension ingest review (independent reviewer, commits 66be071..a390a90)

OK: founders-only access on the editor and the key management; keys shown once and stored as
SHA-256; every ingested point goes through the C4 write path (exact decimals, no future or
unfinished periods, company isolation, holding-fed numbers refused, a founder's number never
replaced); 0021 / 0022 additive with RLS + revoke on the new tables; no AI provider, key or
network call.

## Findings (verified)

1. MED ingest rate limit bypassed by parallel requests (`src/server/http/ingest.ts:101`,
   `src/server/services/extension.ts:167-173`): the limit counts log rows written AFTER
   processing, so 150 concurrent requests → 150 × 200. Fix: an atomic per-key-per-minute
   counter (`INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n`, new small table with
   RLS) checked BEFORE processing; error / 500 paths count too. Concurrency test.
2. MED extension calls push "Source disagrees" off the cards (`metrics.ts:228-234` reads the
   last 200 connector runs per company; every ingest call creates a run). Fix: newest relevant
   run per connector / metric (DISTINCT ON or a dedicated conflicts query); no run when nothing
   was written / conflicted / agreed. Test: after 205 unrelated calls the disagreement still
   shows; real connector conflicts unaffected.
3. LOW salary guard bypass (`narrative.ts:41-43`): "З/П сотрудников", "Зар. плата",
   "Compensation", key `fotTotal` passed. Widen the list (з/п, зар. плата, зарплат, заработн,
   оклад, премия / преми*, бонус, bonus, compensation, payroll, wage, salary, fot as a word /
   camel / snake part) AND add an explicit per-metric `is_pay_data` flag (additive migration;
   seed true for pay-like metrics; piecework_total stays allowed by the allow-list), checked in
   addition to names. Tests for each variant.
4. LOW Org Expert "monthly on day 1" coerced to weekly Mondays (`ai-roles.ts:217`,
   `org-expert.ts:39`): remove the runtime coercion (0021 already rewrote the rows) or refuse
   with a clear message; test.
5. LOW non-numeric revert version → 500 (`ai-role-editor.ts:296-318`): validate a positive
   integer → not_found / invalid; test.
6. LOW no way back to the defaults: add "Reset to defaults" (logged as a version) for roles and
   hires; test.
7. LOW the middleware exemption matches `/api/v1/ingest/*`: match exactly `/api/v1/ingest`;
   test.
8. LOW unauthenticated 401s are unlimited: a cheap per-IP limit for failed auth (same atomic
   counter table) plus cheap pre-checks (header shape) before the DB lookup; test.
9. LOW `extension_ingest_log.key_id` ON DELETE restrict while keys cascade from users: make it
   SET NULL (additive migration altering the FK); test.
10. LOW CORS accepts any chrome-extension ID: optional `EXTENSION_ALLOWED_IDS` (comma list);
    when set only those IDs; document in README / .env.example; test both modes.
11. Test gap: `updateHire` + `logSettingsChange` run outside a transaction → wrap them in one
    transaction with a row lock; test that concurrent edits log the correct `before`.

## Resolution

All 11 fixed on `claude/adoring-brown-rriwam`, one commit per item (30fc968..4b258bb), plus
this document and the README. Verified with `npm run db:migrate`, `lint`, `typecheck`, `test`
(58 files, 596 tests; 577 before), `build` and `test:e2e` (23 passed, 9 skipped — screenshots
by default). New migrations, all additive: `0023_ingest_rate_counters` (new table, RLS +
revoke), `0024_metric_pay_flag` (column + backfill), `0025_settings_log_reset` (widens a CHECK),
`0026_ingest_log_key_set_null` (FK → SET NULL, column nullable); each tested on existing data in
`migrations.test.ts`, and `rls.test.ts` still finds RLS on every table. Still no SDK, key or
network call.

1. **Rate limit (MED)** — 30fc968. `ingest_rate_counters (bucket, window_start, n)`, fixed
   one-minute windows. `takeIngestSlot` does the atomic upsert for `key:<id>` right after
   authentication and before anything else, so refused (400 / 413 / 415) and failing (500)
   calls use a slot; over 60 → 429 with `Retry-After` = seconds left in the window. A new
   window deletes windows older than an hour. Tests: 150 parallel requests → exactly 60 × 200
   and 90 × 429 (and 60 log rows); a refused call counts; a call that fails with 500 counted.
2. **"Source disagrees" (MED)** — aa19b72. Connectors: `DISTINCT ON (connector, company)`
   latest finished run (no 200-row window). Extension: one query over the runs'
   `conflicts` / `agreed` arrays, `DISTINCT ON (metric, period)` ordered by newest run — the
   newest run that mentions the number decides, however many calls came after. An ingest call
   that wrote, conflicted and agreed with nothing deletes its run. Test: a manual-vs-extension
   and a manual-vs-connector disagreement both still show after 205 unrelated extension calls
   (fails on the old code); a no-op call adds no run; an agreeing call still clears.
3. **Salary guard (LOW)** — e7667f6. Word list widened as asked (премия / премии but not
   «премиум»; FOT as a Latin word; keys split into camelCase / snake_case parts, so `fotTotal`,
   `totalFot`, `staffBonus`, `zpTotal` match while `photos`, «Фото», «Comfort» don't).
   `metric_definitions.is_pay_data` (0024): existing pay-named metrics flagged by an SQL backfill
   (piecework_total and look-alikes not); the seed sets it from the names. The flag is checked
   in addition to names: `isSalaryMetric` (custom roles can't watch it, also at run time) and
   `salaryLikeFinding(f, payKeys)` (left out of the prompt; also the "N findings left out"
   count) — the flag wins over the allow-list. Tests: every variant (unit), the flag in
   `salaryLikeFinding` / `generateNarrative`, custom-role refusal by flag and by the new words,
   the 0024 backfill.
4. **Org Expert schedule (LOW)** — 73758d6. Coercion removed in `settingsOf`,
   `orgExpertHires` and `templateScheduleLabel` (0021 rewrote the legacy rows). The morning line
   says "(monthly)" for a monthly hire. Test: monthly day 1 is stored and labelled "Monthly on
   the 1st", no line on a Monday, a line on the 1st.
5. **Revert version (LOW)** — af119e8. `parseVersion`: a positive integer (or its digits as
   text) within the integer range, otherwise `not_found` "Version not found". Test: "abc", "",
   "1.5", "1e3", -1, 0, 1.5, NaN, Infinity, 2^40, null, objects — roles and hires.
6. **Reset to defaults (LOW)** — d725a38. Editor button "Reset to defaults" (with a confirm):
   built-in role → no role-level edits (the code's defaults); custom role → its first (create)
   version; hire → the role's defaults for its company (schedule, thresholds, numbers needed,
   recipients, month totals), own checks / name / head limit cleared, notes kept. Logged as
   action `reset` (0025), shown "reset to defaults" in History, revertible; nothing logged when
   already at the defaults. Tests in `ai-role-reset.test.ts`.
7. **Middleware (LOW)** — d71686a. `/api/v1/ingest` is an exact-match exemption. Test:
   `/api/v1/ingest/anything` and `/api/v1/ingest/v2/x` get 403 (POST, same-origin guard) and
   401 (GET, session).
8. **Failed auth (LOW)** — dfff80b. A header that isn't `Bearer fcx_` + 43 base64url
   characters → 401 with no database query. A well-formed unknown / revoked key counts a
   failure in `authfail:<ip>` (first X-Forwarded-For entry, else X-Real-IP); with 20 in a minute
   the IP gets 429 + Retry-After before the key lookup for the rest of the minute. Test: zero
   database calls for malformed headers; 20 × 401 then 429; a valid key from that IP waits,
   other IPs pass, the next minute passes. (Trade-off: a valid key from a blocked address waits
   at most a minute.)
9. **Log FK (LOW)** — 74b747c. 0026: `key_id` nullable, ON DELETE SET NULL; Settings shows
   "Deleted key". Tests: 0026 on existing data (restrict before; after it a key delete and a
   user delete cascading through keys keep the log rows, unlinked) and the service view.
10. **Extension IDs (LOW)** — 4b258bb. `EXTENSION_ALLOWED_IDS` (comma list, trimmed): set →
    only those IDs get CORS / the preflight, any other extension is refused (403) like a web
    origin; empty → any extension. Documented in `.env.example` and the README. Tests: both
    modes, preflight and POST, no-Origin scripts unaffected.
11. **updateHire transaction (test gap)** — 2fef555. The hire row is locked
    (`SELECT … FOR UPDATE`) and read, merged, validated, written and logged in one transaction;
    open runs are re-checked after it. Test (`ai-hire-concurrency.test.ts`): three concurrent
    edits all land, versions are consecutive and each `before` equals the previous `after`
    (fails on the old code).
