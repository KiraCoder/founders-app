# Staff on Telegram review (independent reviewer, commits caf40ec..bf49306)

OK: a person is messaged only after they started the bot themselves and a founder switched them
on; `/stop`, pause and unlink are honoured at send time; buttons carry one-time tokens bound to the
person; `staffTasksWhere` keeps a person to their own shared tasks; Russian texts; 0028 additive
with RLS + revoke on the three new tables.

## Must fix
A. HIGH noise: burst on switch-on and the chase dies by midday (`planner.ts:planForPerson`
   ~224–246). One chase row per task per slot: a person with 8 overdue tasks gets 8 messages the
   moment they are switched on, 8 more every 2 hours, and the daily cap (12) is gone by the second
   slot — so chasing stops before noon, the opposite of "keep asking until done".
B. MED `outbox.ts:138 cancelPendingForTask` cancels every pending row of the task, including a
   `staff_update` (help / deadline request push): a founder's Snooze, Done or +N day on the task
   silently drops the person's "Нужна помощь" or deadline request.
C. MED dev tools: "Run tick now" / "Simulate morning" (`dev/notifications/actions.ts:26`) plan and
   dispatch staff rows too. A simulated morning creates real people's rows at a fake time; on a
   preview with a bot token they are marked "sent via dev", using up the person's slots and daily
   cap while they never see a message.
D. MED `decideDeadlineRequest` (`task-comments.ts`) has no founders-only check and marks the
   request approved before moving the deadline: a failure in between leaves "approved" with the
   old deadline.
E. MED re-escalation: the escalation key `esc:<task>:<due>:count` is once per deadline. After the
   person answers once, chasing resumes, and if they go quiet again for N chases the founder is
   never told again.
F. LOW-MED a sent `staff_update` about a task counts as the founder's one push for that task today
   (`usedToday` by task id): a help push at 10:00 cancels the founder's 12:00 due-today nudge.
   Either document it or exclude it.
G. LOW `collectParked` lists a parked deadline-request line even after the request was approved or
   declined on the task page.
H. LOW `/stop` cancels only `pending` rows; rows held as `not_linked` or `parked` survive.

## Resolution

All 8 items fixed on `claude/adoring-brown-rriwam`, with tests in
`tests/integration/staff-telegram-review.test.ts` (11 tests) and `tests/unit/staff-planner.test.ts`
(grouped chase, cadence groups, escalation key). No migration.

A. **One grouped chase per person per slot.** `planForPerson` now queues ONE `staff_chase` row per
   person per slot (`chase:<day>:<HH:MM slot start>`) whose `payload.tasks` lists every task due a
   chase in that slot (a task with its own cadence joins the group of its own slot start; the row
   expires at the latest slot end of its tasks). Re-planning the same slot updates the waiting
   row's list. The dispatcher rebuilds the message at send time from each task's current state
   (`staff-dispatcher.ts:buildChase`: still theirs and open, same deadline, chasing on, not already
   listed in this slot, its new-task message not sent in the slot or still waiting), sends one task
   as the usual «Напоминание: …» and several as `buildStaffGroupedChase` (`messages-ru.ts`): a
   numbered list with a keyboard row per task (*N · Готово / Помощь / Срок*, at most 8, then
   «…и ещё N — /tasks»), fitted to Telegram's limit like the founders' grouped chase (a task not
   listed has no buttons and is not counted as chased). The sent row stores `payload.listed`
   (per-task chase counts, delivery trail) and gets `task_id` when it listed exactly one task (a
   text reply then becomes that task's comment). **No chase in the slot the person was switched
   on** (`enabledAt >= slotStart`). The daily cap counts messages, so a grouped chase is one: test
   "8 overdue tasks → 1 message per slot with buttons per task, and chasing goes on all day" (six
   slots, six messages, no `daily_cap_full`) and "no burst on switch-on".
B. `cancelPendingForTask` skips `kind = 'staff_update'`. Test: Snooze, +1 day and Done by the
   founder keep the pending help and deadline-request pushes.
C. The founders' dev buttons call `runTick(..., { staff: false })` (planner and dispatcher skip
   people). New **Simulate staff tick** button (`runStaffTickAction` → `runStaffDevTick`): staff
   only (`dispatch({ onlyStaff: true })`), at the real current time (no fake slot), and **refused
   while a Telegram bot token is set** — without a token the dev inbox is the only channel, so it
   does exactly what the next real tick would and uses no slot or cap the real tick would not.
   Tests: dev tick creates no person rows; staff tick throws with a token and sends only person
   rows without. The e2e uses the new button.
D. `decideDeadlineRequest` starts with `assertStaffBotAccess` and runs the claim + `changeTaskDeadline`
   in one transaction. Test: a non-founder is refused; a deadline move that fails (a test trigger)
   leaves the request `pending` and the deadline unchanged.
E. The count escalation key is `esc:<task>:<due>:count:<last answer ISO | never>`; the planner
   passes each task's last answer (`answeredAt`). Answers are logged with the context clock
   (`created_at = pctx.now`). Test: 3 silent chases → escalation; Принято; 3 more silent chases →
   a second escalation. The cut-off-time heads-up stays once per deadline.
F. Chosen: **excluded**. The "one push per task per day" check uses `taskTouchFilter`
   (`task_id = X and kind <> 'staff_update'`), in single pushes and in the grouped chase; a team
   update still uses the daily budget. README updated. Test: a help push sent at 10:05 and the
   founder's 12:00 due-today nudge for the same task both go out.
G. `collectParked` drops a `staff_update` whose `payload.requestId` is no longer pending (cancelled
   `no_longer_relevant`). Test.
H. `/stop` (and the founders' switch-off / unlink) cancel `pending` (incl. held for quiet hours or
   pause), `not_linked` and `parked` rows of the person. Test.
