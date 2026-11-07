# C3b Org structure review (independent, commits 4ad6fea^..63163bb)
Transcription of Kiwi Go divisions 7,1,2,3: no errors. Division 4 name "Операции" is a guess — mark "(уточнить)" like its departments.

## Must fix
1. MED-HIGH editing a task silently drops its link to an archived department: TaskForm.tsx department <select> omits archived departments (org.ts:328) → controlled select shows None → saves orgDepartmentId="" → link cleared. Fix: include the current (archived) department as an option "8 Расходы и выплаты (archived)", or omit the field when untouched. Add e2e.
2. MED duplicate department numbers: updateDepartment (org.ts:540) accepts any 1–99, no unique index on (chart, number); createDepartment (org.ts:622-623) caps at 99 → duplicates. Fix: refuse numbers used by a live department in the same chart (service + partial unique index where archived_at is null); refuse create when 99 taken.

## Can wait (do them)
3. Keyboard drag of departments unreliable (custom collision OrgBoard.tsx:283 falls back to closestCenter on different-height cards): fix, or README says ⋯ menu is the keyboard path; add an e2e for real mouse drag-and-drop.
4. Archived check before chart lock (moveFunction org.ts:652, moveDepartment :683, updateDepartment/Function :544, :573): concurrent archive+move both succeed, breaks 0..n sort. Re-check archivedAt (current and target) inside the transaction after the lock.
5. No DB enforcement that org rows stay in their company/chart: add composite FKs (division_id, chart_id) etc. where practical (additive migration).
6. Client sends position from its own copy; `version` returned but never checked → check version (optimistic concurrency) and return a conflict asking to refresh.
7. UI vs screenshot: columns ~270px vs ~175px (make denser, closer to screenshot); ⠿ handles, "+ Функция", "+ Отдел" only in Edit mode (show "+ Функция"/"+ Отдел" in view mode too as in the screenshot, opening edit); task rows don't show their department (add a small dept chip).
Test gaps: archived-dept task edit; duplicate numbers; concurrent archive+move; real DnD e2e; undo of division/department head change.

## Resolution

All 7 findings and the test gaps were fixed on branch `claude/adoring-brown-rriwam`, together
with the founder's follow-up "there are no people on the org board" (see the end). Verified with
`npm run db:migrate`, `lint`, `typecheck`, `test` (53 files, 548 tests), `build` and `test:e2e`.
New migration `0020_org_integrity.sql` is additive (constraints, one partial unique index, a
data fix that is a no-op on clean data); no table is added, so no new RLS statement is needed
(`rls.test.ts` passes; 0020 tested in `migrations.test.ts`).

Transcription note: division 4's name "Операции" stays as seeded; its three departments are
already marked "(уточнить)". The founders confirm the name when they fill division 4.

1. **Archived department dropped on task edit (MED-HIGH).** `TaskForm` adds the task's current
   department to the options as "8 Расходы и выплаты (archived)" when it is not in the live
   list, so the controlled select keeps it and saving sends the same id; `updateTask` only
   re-checks a department that changed, so the link stays. Picking an archived department anew
   is still refused. Tests: `org-review.test.ts` (service) and e2e "a task keeps its archived
   department when edited" (creates a department, a task on it, archives it, edits the task
   title in the form, reloads: the department is still there).
2. **Duplicate department numbers (MED).** `updateDepartment` refuses a number used by another
   live department of the chart ("Number 4 is already used by department 4 Маркетинг");
   restoring an archived department, and undoing a renumbering, onto a taken number are
   refused the same way. `createDepartment` takes one more than the highest number ever used
   (min 22); past 99 the lowest number no department has, then the lowest no live department
   has; none → refused. Database: partial unique index `(chart_id, number) where archived_at is
   null` (0020; any existing duplicates are first renumbered to the next free number from 22
   and logged as `renumber` in the chart's history). Tests: taken number, restore, undo, the
   index, next number / past 99 / all used.
3. **Keyboard drag (can wait, done).** The collision fallback (keyboard drags have no pointer)
   now uses closest *corners* among items of the same type, then the list zones, instead of
   closest centre over everything — better between cards of different heights. The README now
   says the ⋯ menu is the reliable keyboard and phone path. New e2e "real mouse
   drag-and-drop": drags ⠿ of “Testing” onto another department with the mouse, reloads, Undo.
4. **Archived check before the lock (can wait, done).** `moveFunction`, `moveDepartment`,
   `updateDepartment`, `updateFunction`, `createFunction` and `createPersonAndAssign` re-read the
   row (and the move target) inside the transaction after `lockChart` and refuse an archived
   one; restoring a function in an archived department is refused too. Test: archive and move
   of the same function started at once, four rounds — the archive always wins, the move is
   either applied before or refused, and every live list stays 0, 1, 2, … (the test fails with
   the re-check removed).
5. **Rows outside their company / chart (can wait, done).** 0020 adds unique `(id, company_id)`
   on charts and `(id, chart_id)` on divisions and departments, and composite foreign keys:
   divisions / departments / functions / change-log rows → `org_charts(id, company_id)`,
   departments → `org_divisions(id, chart_id)`, functions → `org_departments(id, chart_id)`.
   (`tasks.org_department_id` keeps its plain FK: tasks are checked by `assertTaskDepartment`;
   a composite FK with `ON DELETE SET NULL` would also null the task's company.) Tests: inserts
   and updates crossing a chart or a company are refused (service suite and migration test).
6. **Position from a stale copy (can wait, done).** The chart `version` (newest change-log
   seq) is now checked: every board action sends the version it shows, the service compares it
   right after taking the chart lock and refuses with `conflict` ("The org chart was changed
   meanwhile … The board was refreshed — check it and try again"); the board shows that and
   refreshes. A successful write returns the new version, and the board runs its changes one
   after another with the latest version, so quick consecutive edits by the same founder never
   conflict with themselves. Undo is checked too (it must not take back a change the founder
   has not seen). Tests: stale move and undo refused with nothing changed, current version
   accepted, returned version = the chart's.
7. **UI vs screenshot (can wait, done).** Columns 272 → 212 px with tighter padding and type
   (closer to the old cockpit; Russian texts still wrap readably); *+ Функция* and *+ Отдел*
   show in view mode too and switch to edit mode; task rows show a department chip
   ("1 Найм и ввод в должность"). Screenshots re-taken.

Test gaps closed: archived-department task edit (service + e2e); duplicate numbers (service,
index, migration); concurrent archive + move; real mouse drag-and-drop e2e; undo of division and
department head changes (`org-review.test.ts`).

### Founder's request: people on the org board

- **+ New person** in every person picker (department / division panel heads, each function in
  the panel, the board's "+ назначить" popover): full name, short name, phone, Telegram, role /
  title (default the department's / function's name). `createPersonAndAssign`
  (`services/org.ts`) runs in one transaction under the chart lock with the version check:
  `createPerson` (People rules, savepoint) with a link to the chart's company (and unit),
  then the assignment, then one change-log line ("Added new person Тест Курьеров as head of 1
  Найм и ввод в должность"). Founders only (`assertOrgEdit`). Undo = the existing `update` undo:
  the assignment goes back, the person and the link stay.
- **Names on the board** (view mode): division "Руководитель: <title> — <name>", department
  head's name, function initials in a circle (full name in `title` and a CSS tooltip on hover
  and keyboard focus); empty → "+ назначить" (founders).
- **People pages:** person page *Org positions* section; People list and company People tab
  show positions under the roles (`orgPositionsForPeople`, accessible companies only).
- **Org Expert:** recomputed on every board render (after each assignment); heads /
  responsible people who left or whose company link ended count as nobody, names from People.
- Tests: `org-people.test.ts` (create + assign for department / function / division, link role
  and unit, undo keeps the person, staff forbidden, forged id not found, invalid input /
  archived target / stale version create nobody, other company's chart links to that company
  only, positions, expert before/after and with a person who left), `org-rules.test.ts`
  (initials, schema), e2e "people on the board" (adds “Тест Курьеров” from department 1's
  panel, sees ТК on the board after reload, finds the position on People and the person page).
