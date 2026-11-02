# C3a People review (independent reviewer, commits 2510fe2^..2d9a13f)

Salary confidentiality: no leak found (services via salaries.ts + assertSalaryViewer; non-viewer DTO omits salary key; PeopleTable server-only; SalaryForm viewers only; forged writes refused first; search/pickers clean; no caching; viewer toggle viewer-only + audited; RLS + revokes; Nuraaly backfilled).

## Must fix
1. MED-HIGH zip bomb: src/server/import/parse-table.ts:92-94 loads whole workbook before row check (:100). 890 KB file → +1.3 GB, 15 s. Fix: pre-scan with JSZip (direct dep) — reject >100 entries, any entry declared >10 MB, total >25 MB; ALSO stream-decompress each entry with running byte cap (declared sizes can lie). Applies to every importer (people + numbers).
2. MED importer merges two people / non-idempotent: people-import.ts:375-380, :409. Existing "Асель" no phone; file rows "Асель 0555", "Асель 0777" both match, phone overwritten (breaks never-overwrite); re-import creates duplicate. Fix: track in-memory claims; once claimed with phone X, rows with other phones don't match/fill it.
3. MED PATCH /api/v1/people/:id not atomic (route.ts:296-306). Fix: whole PATCH in one transaction; validate link ids up front.
4. LOW-MED last-viewer rule race (salaries.ts:220-226) + audit not atomic; addPersonSalary (people.ts:428-430) salary + log outside tx. Fix: single conditional DELETE (or FOR UPDATE in tx) with log row in same tx; salary+log in one tx.

## Can wait (do them)
5. Preview vs apply mismatch: return sha256 of file with preview, verify on confirm (all importers).
6. Non-viewer forged mapping of salary column to notes/role accepted (people-import.ts:233-235; UI-only hide ImportWizard.tsx:106). Fix: server refuses salary-detected column indexes for non-viewers.
7. Duplicate link+date salaries in one request share createdAt (salaries.ts:104) → arbitrary current. Fix: reject duplicates or tie-breaker.
8. Re-import of old Excel silently reverts raise — preview must show old → new amounts to viewers (and flag decreases).
9. Migration 0006:39 sets is_active=true on links with ended_on → new additive migration: UPDATE person_companies SET is_active=false WHERE ended_on <= current_date.
10. Headcount excludes founders by role text (people.ts:468) → use people.user_id IS NULL.
11. markLeft ignores leftOn (people.ts:360); undo (status active, :352) leaves roles ended — define: undo reactivates roles ended by that markLeft (same date) or clearly document; honour leftOn.
12. UTF-16 CSV (BOM FF FE / FE FF) misdetected (parse-table.ts:45-51); formula-leading values (= + - @) must be neutralised on any future export — add a shared csv-safe helper now + test.
13. Search ё/е insensitivity (people.ts:191).
14. Concurrent imports → duplicates: pg_advisory_xact_lock in applyImport (works on PGlite?) — verify.
15. isSalaryViewer should recheck user is founder (role).

## Test gaps
zip-bomb/oversized entry; same-name different phones + re-import; partial-failure PATCH rolls back; concurrent mutual revoke; forged non-viewer mapping; migration with ended_on; duplicate salary link+date; UTF-16 CSV; e2e that Talant's HTML/RSC payload contains no salary amounts.

## Resolution

All 15 findings and the listed test gaps were fixed on branch `claude/adoring-brown-rriwam`.
Verified with `npm run db:migrate`, `lint`, `typecheck`, `test` (225 tests), `build` and
`test:e2e`. New migration `0008_people_fixes.sql` is additive (two columns + data fixes; no
new table, so no new RLS statement is needed — `rls.test.ts` still passes).

1. **Zip bomb (MED-HIGH).** `assertSafeXlsx` in the shared `src/server/import/parse-table.ts`
   runs before ExcelJS sees the file: JSZip (now a direct dependency) reads only the central
   directory and refuses more than 100 entries, any entry declared above 10 MB or a declared
   total above 25 MB; then every entry is unpacked as a stream with a running byte cap
   (per entry and total), stopped as soon as it passes the limit, so forged sizes do not help.
   `parseTableFile` is the only parser used by both the people import (`people/actions.ts`) and
   the numbers upload (`companies/actions.ts`). Tests (`import-file-safety.test.ts`, bombs
   generated at runtime, nothing stored): 30 MB-of-zeros entry in a file under 200 KB refused in
   well under 5 s, one 10 MB+1 entry, an entry whose declared size was patched to 1000 bytes
   (stopped by the stream cap), 101 entries, a normal workbook still parses, and both server
   actions (people and numbers) answer the bomb with a message and no preview.
2. **Importer merging two people (MED).** A row that fills the phone of a phoneless person now
   *claims* that person in memory (phone and other filled fields are updated in the plan), so
   a later row with the same name and another phone no longer matches: it becomes a new person.
   The write is also guarded in SQL (`coalesce(existing, new)` per filled field), so an
   existing value is never overwritten even if it changed after planning. Test: existing
   "Асель" without phone + rows with 0555 and 0777 → update + create, phones kept apart;
   re-import → skip, skip, still two people.
3. **PATCH not atomic (MED).** New service `patchPerson` (`people.ts`) does the whole PATCH in
   one transaction (nested service calls become savepoints). Salary permission, link ids
   (must belong to this person) and duplicate salaries are checked before anything is
   written. The route only parses JSON and calls it. Test: name change + new link + a failing
   link edit → 400 and neither the name nor the link is kept; a foreign link id → 404, nothing
   written.
4. **Last-viewer race, audit atomicity (LOW-MED).** `setSalaryViewer` runs in one transaction
   that locks all `salary_viewers` rows (`SELECT … FOR UPDATE`), re-checks that the actor is
   still a viewer, applies the last-viewer rule and writes the audit row in the same
   transaction. (A single conditional DELETE was not used: under READ COMMITTED two such
   deletes can both see two viewers.) `addSalary` writes the salary and its audit row in one
   transaction (a savepoint inside callers' transactions), which covers `addPersonSalary`,
   new links with salary and the importer. Test: two viewers revoking each other at once →
   exactly one viewer and one revoke row remain.
5. **Preview vs apply (can wait, done).** `parseTableFile` returns the file's sha256; both
   previews return it (`fileSha256`), both wizards send it back with the confirm step, and
   `applyImport` / `applyMetricsImport` require it (`assertSameFile` in
   `services/import-common.ts`, `conflict` otherwise, nothing written). Tests for both
   importers, plus an e2e that goes through the people wizard to *Import*.
6. **Forged non-viewer mapping (done).** For a non-viewer, `buildPlan` refuses (`forbidden`)
   any field mapped to a salary-looking column (`salaryHeaderIndexes`), and `guessMapping`
   never suggests such a column for any field. Test: Talant mapping Оклад to notes / role /
   phone is forbidden in preview and confirm; Nuraaly may.
7. **Duplicate link+date salaries (done).** A PATCH with two salaries for the same link and
   effective date is refused (400). For rows written in the same instant from separate calls,
   `salaries.seq` (identity column, backfilled in created_at order by 0008) is the final
   tie-breaker: the row written last is current. Tests for both.
8. **Re-import reverting a raise (done).** For salary viewers each preview row carries
   `salaryBefore` and `salaryDecrease`; the change text reads "Salary 40 000 KGS → 35 000 KGS
   (DECREASE — check the file is current)", the plan counts `salaryDecreases`, and the wizard
   shows old → new in the salary column (decreases in red with ▼) and a warning banner above
   the table. Non-viewers get none of these fields (test checks the JSON).
9. **0006 left ended links active (done).** 0008 sets `is_active = false` where `ended_on <=
   current_date`. Migration test with past, future and open end dates.
10. **Headcount by role text (done).** Founders are excluded by `people.user_id IS NULL`, not
    by the role "founder". Test: a person without an account whose role is "founder" counts.
11. **markLeft ignored leftOn; undo (done).** `left_at` is the leaving date (start of that day
    in Asia/Bishkek; exactly now when it is today), links end on that date, a future date is
    refused (validation). Decision on undo: new column `person_companies.ended_by_leave` marks
    the links that *Mark as left* ended; undo (status active) reactivates exactly those links
    (end date cleared). Links ended by hand stay ended; any manual link edit clears the flag.
    0008 backfills the flag for people who already left (links ended on their leaving day).
    Tests for both and for the future date.
12. **UTF-16 CSV; formula cells (done).** `decodeText` detects BOM FF FE / FE FF (shared by both
    importers). New `src/lib/csv-safe.ts` (`csvSafe`, `toCsvLine`) prefixes text starting with
    `= + - @ \t \r` with `'` and quotes as needed; numbers stay numbers. No export exists yet;
    the README says every future export must use it. Tests: UTF-16 LE and BE, csvSafe cases.
13. **Search ё/е (done).** Name, short name, role and title compare with `translate(…, 'ёЁ',
    'еЕ')` against the query with ё → е (global search uses the same function). Test both ways.
14. **Concurrent imports (done).** Verified that `pg_advisory_xact_lock` works on PGlite
    (test: the lock is listed in `pg_locks` inside the transaction and gone after commit), so
    no lock-row table was needed. `lockTransaction` (`services/locks.ts`) is taken first in
    `applyImport` (key `people-import`) and `applyMetricsImport` (per company), before
    re-planning. Test: two confirms of the same new file at once → 2 + 0 applied, each person
    once.
15. **isSalaryViewer founder recheck (done).** Requires `ctx.user.role = founder` and joins
    `users` with `role = 'founder'` in the database. Test: a viewer row whose user was changed
    to staff (stale session still saying founder) gets nothing.

Test gaps closed: zip bomb / oversized / lying entry / entry count; same name different phones +
re-import; partial-failure PATCH rolls back; concurrent mutual revoke; forged non-viewer mapping;
migration with ended_on (0008 test); duplicate salary link+date; UTF-16 CSV; e2e that Talant's
raw HTML and RSC payload (`RSC: 1`) of /people, the person page and the company People tab
contain no salary amount (with a sanity check that Nuraaly's HTML does).
