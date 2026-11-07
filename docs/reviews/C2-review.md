# C2 Notifications + Telegram review (independent reviewer, commits d995fd0..541fdef)

Verified OK: no cross-founder leak (summaries, /today, /tasks via getTodaySummary(ctx); chases via getTask; parked bundles by userId; callback tokens 128-bit hashed single-use 7d user-bound; dev inbox own rows; settings scoped). Founder-only recipients in enqueue + dispatcher. Group chats refused. Constant-time secrets; missing secret → 401. Link codes ~40 bits/15min/single-use. Quiet hours across midnight OK. Migration additive (dedupe unique loosened to per-user, fine).

## Must fix
1. HIGH Snooze → duplicate push. services/notifications.ts:65-77 sets snooze exactly 24h + queues task_reminder at that moment; planner.ts:89,103 skips only while snoozedUntil > now. On next chase day the 12:00 tick sends task_reminder AND overdue_chase (same for due-today nudge). Fix: planner skips a task with a sent/pending task_reminder today, or shared dedupe key per task/day (e.g. `touch:${task}:${localDay}`) so only one push per task per day of any kind.
2. HIGH Lease doesn't prevent double sends. dispatcher.ts:172 lease = tickStart+2min (not wall clock); telegram-api.ts:258 fetch has no timeout. Slow tick → expired lease → next tick resends. Crash between send and finish → resend after 2min. Dev tick action (dev/notifications/actions.ts:52-58) passes past `now` → leases expired from start. Fix: atomic claim (status='sending' with claimed_at wall-clock; reclaim only after e.g. 10 min), AbortSignal.timeout(10_000) on fetch, lease uses real clock.
3. MED-HIGH Urgent-priority tasks bypass budget unbounded (planner.ts:50-51 maps task priority urgent→notification urgent; dispatcher.ts:221). Fix: bypass only for explicit `urgent` kind; urgent-priority task pushes get a separate small cap (2/day) or just queue priority. Urgent sends shouldn't consume normal budget inconsistently — define clearly and test.

## Can wait (but do them)
4. MED Unlinked founder in production: channels.ts:233 falls back to DevChannel even with bot token → items marked sent, consume summary slot/budget, parked items bundled, lost. Fix: in production (token set) hold as `not_linked` (or cancel) instead; don't consume budget.
5. LOW-MED No per-item try/catch in dispatch; one bad item aborts loop for both founders. Malformed quiet_start throws in hmToMinutes. Fix: per-item try/catch with attempts++; DB CHECK constraints on HH:MM columns and max_other_per_day; make notification_preferences RLS policy select-only (writes via service).
6. LOW Evening check inside quiet hours never arrives (22:00 with quiet 21–08 → held then expired). Fix: validate in settings schema (reject or warn) — reject with clear error.
7. LOW Budget check not atomic across overlapping ticks (fixed by #2 claim); parked lines keep stale text ("3d overdue") and remain after deadline moved — re-render at bundle time from current task state and drop if no longer relevant; cancelPendingForTask should also cancel `parked`.
8. LOW webhook/route.ts:139 returns bot replies in JSON when NODE_ENV!==production or no token → only when devToolsEnabled() && no token. Dispatcher caches chatId per tick (unlink race) — re-read link before each send.
9. LOW Dev tick on previews with DEV_TOOLS=1 and real token sends real Telegram messages to both founders with backdated sentAt → dev tick action must use the dev channel only and only for the current user.

## Test gaps
Concurrent/slow dispatch (lease); snooze then next chase day; urgent vs budget; unlinked founder with token; webhook response in production mode; group-chat callbacks; old buttons after unlink/relink to other founder; parked after deadline move; middleware public paths; non-midnight quiet window (13:00–15:00).

## Resolution

All 9 findings and the listed test gaps were fixed on branch `claude/adoring-brown-rriwam`.
Verified with `npm run db:migrate`, `lint`, `typecheck`, `test` (135 tests), `build` and
`test:e2e`. No real Telegram call is made anywhere in the tests (fetch is stubbed).

1. **One push per task per day (HIGH).** The due-today nudge, the overdue chase and the
   "Snooze 1 day" reminder now share the dedupe key `touch:<task>:<local day>`
   (`taskTouchKey` in `types.ts`), so the unique `(user_id, dedupe_key)` index allows only
   one per task per founder per Asia/Bishkek day. The snooze reminder takes the key of the
   day it fires (`scheduleTaskReminder` in `outbox.ts`; a second snooze the same day revives
   that row with the new time instead of adding one). The dispatcher also cancels a task
   push as `already_pushed_today` when another push for that task was sent (or is being
   sent) that day, which covers rows queued under other keys. Tests: snooze then a chase day
   (ticks every 30 minutes all day: only the reminder), snooze of a task due tomorrow,
   double snooze, two keys for one task.
2. **Atomic claim (HIGH).** The dispatcher claims one item at a time with
   `UPDATE … SET status='sending', claimed_at=<wall clock> WHERE id = (SELECT … LIMIT 1
   FOR UPDATE SKIP LOCKED)`; the same statement works on PGlite. Every outcome clears the
   claim. A `sending` row is retaken only when its claim is older than 10 minutes
   (`STALE_CLAIM_MS`), which counts as one attempt (`lastError = stale_claim`; failed at
   `MAX_ATTEMPTS`). Claims use the real clock (injectable for tests), so the dev tick's
   simulated `now` no longer matters. Telegram calls use `AbortSignal.timeout(10_000)`
   (getUpdates long polling gets its wait on top). Tests: a slow run blocked inside `send`
   while a second run (5 logical / 9 real minutes later) finds nothing; stale claim retaken
   only after the timeout; repeatedly abandoned claim fails; timeout signal present and a
   hung request returns an error.
3. **Urgent vs budget (MED-HIGH).** Rule (`budgetClass` in `dispatcher.ts`, README):
   summaries have their own slots; only kind `urgent` skips the budget (nothing creates it
   automatically today); pushes about urgent-priority tasks do not use the normal budget
   but have their own cap of 2 per founder per day (`URGENT_TASK_PUSHES_PER_DAY`), then are
   parked (`urgent_cap_full`); everything else uses "max other pushes per day". Quiet hours
   are unchanged (urgent kind or priority passes only with "urgent at night"). Tests: 4
   urgent + 4 normal overdue tasks → 2 + 3 sent, 2 + 1 parked; explicit `urgent` sent with
   a budget of 0 while a high-priority reminder is parked.
4. **Unlinked founder with a token (MED).** `ChannelRegistry.resolve` returns null when a
   token is set and the founder has no chat; the item becomes `not_linked`: not sent, no
   budget used, no parked items bundled, not retried every tick. At the start of each run
   items of founders who are now reachable go back to `pending` and are then sent if still
   valid (expired ones are cancelled). The dev inbox is used only without a token
   (`createDevRegistry`). Tests: held then released after linking (summary includes the
   older parked item), no network without a token.
5. **Per-item failures and bad settings (LOW-MED).** Each item runs in its own try/catch:
   an unexpected error is recorded on that item (`internal: …`, attempts+1, backoff, failed
   at the limit) and the run continues. Migration `0005_notifications_hardening.sql` adds
   CHECK constraints for the four HH:MM columns and `max_other_per_day` 0–10 (repairing any
   malformed row first); `loadPreferences` also falls back per field. No new table, so no
   new RLS. `supabase/policies.sql`: `notification_preferences` is select-only for clients
   (and the earlier insert/update grant is revoked on re-run). Tests: one founder's item
   throws, the other's is sent; DB rejects bad values; migrating a populated 0004 database;
   policy check as a signed-in client.
6. **Evening check inside quiet hours (LOW).** `notificationPrefsSchema` rejects an
   enabled evening check inside quiet hours with a message on the evening time field
   (shown by the Settings form). Allowed when the check is off. Tested incl. a 13:00–15:00
   window.
7. **Parked items (LOW).** Budget races are closed by #2 plus counting in-flight
   (`sending`) items. At bundle time each parked item is re-checked as the recipient:
   closed, invisible or no longer overdue/due-today items (deadline moved) are cancelled as
   `no_longer_relevant`; the line is rendered from the task's current state (`parkedLine`),
   one per task. `cancelPendingForTask` also cancels unbundled `parked` and `not_linked`
   items. Tests: deadline moved in the app → dropped; next-morning line says "2d overdue";
   Done button cancels a parked item.
8. **Webhook response and link cache (LOW).** Bot replies are returned in the JSON only
   when dev tools are on and no token is set. The dispatcher re-reads the founder's link
   before every send. Tests: route in dev, production and dev-tools-with-token modes; an
   unlink during a run affects the next item.
9. **Dev tick (LOW).** `runTickAction` runs plan + dispatch for the signed-in founder only
   (`userIds`) with the dev registry, so it never reaches Telegram, even on a preview with a
   token. Test: with a token and both founders linked, only Nuraaly's items are created and
   all go to the dev channel.

**Test gaps closed:** concurrent/slow dispatch; snooze then next chase day; urgent vs
budget; unlinked founder with token; webhook response in production mode; group-chat
callbacks (token not consumed, still works from the private chat); old buttons after unlink
and after relinking the chat to the other founder; parked after deadline move; middleware
public paths (look-alike paths are not public); non-midnight quiet window (13:00–15:00).
Tests live in `tests/integration/notifications-hardening.test.ts`, plus additions to
`notifications.test.ts`, `migrations.test.ts`, `tests/unit/notifications-planner.test.ts`
and `tests/unit/request-guard.test.ts`.

Open / behaviour to know:
- A Telegram send that times out is retried; if Telegram had in fact delivered it, the
  founder can get that one message twice (rare; the alternative is losing it).
- A run that crashes after Telegram accepted a message but before recording it resends it
  after 10 minutes (same trade-off).
- On a preview with a real token, a dev-tick "sent" item counts as delivered (dev inbox)
  and will not also go to Telegram.
- Overlapping runs count each other's in-flight pushes, so near the budget limit both may
  park (errs on the side of fewer messages).
- Rows queued before this change keep their old keys (`chase:`/`due:`/`snooze:`); the
  dispatcher's per-task check still allows only one push per task per day for them.
